# 0171 audio mix (M5): technical design

The build-ready design for [ADR 0171](../../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md) (Accepted, direction): the profiler and captures, loudness metering, live mixing, signal-driven ducking and stamped bus ramps. Read [goal.md](goal.md) and the record first, then these documents.

| Document | Owner | What it holds |
|---|---|---|
| [architecture.md](architecture.md) | architect | components and channels; lifecycles (recorder, capture, live edit, meters); sequences (capture start/stop, drag, structural edit with the dip and its late-batch rule, rebuild replay, hidden tab, import); the stream and its clock (epoch, frame, seq; EPOCH and GAP; the live link's framing on paper); the recorder ring; the CPU counters; loudness data flow and integrity; the seven gain lanes and stamped bus ramps; post-fader sends; the slot table; sidechain and the bus order; the ladder step; **every constant** (§5.3); memory (§6); **the cost model** in µs and metered instructions (§7); failure modes; observability; platforms; resolutions (§14) |
| [api-and-models.md](api-and-models.md) | senior engineer | public API (`Bus.volume`/`authoredVolume`, `Bus.loudness`, `Audio.capture`, capability flags, debug); settings; byte-exact wire (ABI 4.0, `BUS_RAMP`, `BUS_SLOT`, `BUS_DUCK`, `BUS_PRESENCE`, `LOUD_CONFIG`, STATUS at 20 KB); the capture file; `MixOp`, the slot table and the `onSectionChanged` hook (amends 0147); editor models; layout; Babylon; test plan; **the task table** (§11); resolutions (§14) |
| [contracts-architect.md](contracts-architect.md), [contracts-senior.md](contracts-senior.md) | each author | contracts C1–C27 and S1–S14, all closed |
| [review-round2-architect.md](review-round2-architect.md), [review-round2-senior.md](review-round2-senior.md) | each author | cross-reviews |
| [rulings.md](rulings.md) | coordinator | R1–R25 and the provisional owner list |
| [BRIEF.md](BRIEF.md) | coordinator | the authors' brief: ownership, must-read list |

The owner's working rules from M3 still apply: [../0162-audio-spatial/working-notes.md](../0162-audio-spatial/working-notes.md).

## How it was made (2026-11-12)

1. **Round 1:** the two authors drafted in parallel, in separate worktrees. The senior engineer owned bytes, settings, file formats, the API and the task table; the architect owned constants, timing, memory and failure behaviour. Both found independently that the record's trigger-first sort fixes no presence-mode delay (presence reads voice counts on main, `mixer.ts:200-213`) and that `max_buses` is 32 on every preset.
2. **Round 2A:** cross-reviews. Architect: approve with changes, 0 blocking, 6 major, 10 minor. Senior: approve with changes, 2 blocking (`BUS_MIX` bit-identity; the dip's F0 race), 6 major, 7 minor. Six points **crossed** (each author conceded to the other's round-1 position).
3. **Rulings R1–R25:** issued in one batch after checking the code facts they rest on (the send is taken before the gain stage, `bus.rs:540` against `:547-568`; ADR 0147 is Proposed; `loadPermille` is 0 today; tests hard-code 16,384).
4. **Round 2B:** both revised and ended with resolutions tables. One relay: the architect's C27 (the dip sequence's late-batch rule) needed a wire tag; the senior encoded `sequenceId` in `BUS_RAMP.shape` bits 3–15 and `BUS_SLOT` offset 16.

## Coordinator verification

| Check | Result | Fix |
|---|---|---|
| Mermaid diagrams | 13 of 13 render (Mermaid 10.9.1, headless Chromium): architecture 10, API 3 | — |
| Code citations | Checked: `schema.rs:73-74` (16,384 B buffer, worst case 16,192); `bus.rs:386-399` (order by depth, then index); `bus.rs:437-440` (RESET settles ramps on targets); `bus.rs:540, 547-568` (send before gain); `zones.rs:116` (`IDLE_MARGIN_QUANTA`); `counters.rs:392-395` (`workUnits` last quantum); `recovery.ts:32-38` (`RebuildReason`); `core/context.ts:239-247` (decode, then RECYCLE: the recorder copy must sit between, and both documents put it there); `core/context.ts:92` (`MAX_BUSES`); `audioSettingsModel.ts:207` (8,192 logical voices); `coreDriver.ts:1032-1034` (oversized block dropped); `src/editor/sdk/project.ts:42-43` (`changed()` taken); `lookahead.ts:27-31` | all hold |
| Facts about today | The committed mixer wasm is **319,799 B** (`ls -l`); the gate is `MIXER_LIMIT = 320 * 1024` = 327,680 B (`native/audio/build.mjs:27`). The projected ≈ 347–351 KB is a tripwire move to record in the build log (R25) | — |
| Task table | Re-summed by script: **79 rows**; M5-0 57, M5a 97.5, M5b 45.5, M5c 71, M5d 29.5 = **300.5 d** (S 113.5, M 172.5, J 14.5); every dependency names an existing task; the reserve's ten items sum to 60 | matches the document |
| Consistency | Shared terms searched in all four files: seven lanes, `DRAG_RAMP_MS` 10 / `BUS_MIN_RAMP_MS` 5, `CAPTURE_TRIGGER_MAX_FILES` 16, 64 MiB, `keyframeIntervalMs`, `loadPermille` 0 on the wire, `onSectionChanged`, `BUS_MIX` retired, EPOCH reasons without resume, `TOMBSTONE_TAIL_FRAMES` 128, `sequenceId`. The architecture's `[API §n]` references match the API's current headings | Task rows Wa1 and Bn2 still said "17,732 B"; now **17,824 B**, as §4.3 states |
| Numbers vs spikes | Capture sizes trace to S3's "Compressed" table, **raw stream** column (0.27 / 0.84 / 2.45 MB per minute) and raw rates (1.70 / 4.08 / 10.85 MB per minute, `spikes/audio-mix/capture/README.md:24-33`); the record's 0.08 / 0.15 / 0.25 is the delta column (stale since change 2) | to correct in the record (write-back) |
| Spot re-measurement | Not run. No measured number moved during the design; the open numbers (floor conversion, real-scene capture sizes, real-core recorder cost) are reserve items and benches (Bn2, Bn3) or owner item 3. Per the owner's rule, no run that can't change a decision | — |
| Stale decisions | The record's text that the design corrects: the sort's presence claim (change 26), capture sizes, "master + 7", five gain factors, taint from MASTER ≠ 1, the hook's name, `loadPermille` filled by the core | listed for the write-back after the owner decides |

**Estimate, line by line:** the record's provisional ≈ 58 pw of tasks, 62–75 total → round 1: 284 d + 57 d reserve = 68.2 pw → round 2B: **300.5 d** (+16.5: B1 split +2, Rv1 +4, B2 +1, Wa1 +1, Wa2 +0.5, Sa1 +0.5, Rc1b +1.5, Rc6 +2, Rc4 +0.5, Pf7 −1, Ld8 +1.5, Ld4 +0.5, Ma3 +1.5, Hk1 +0.5, Dbg1 +0.5, Mx3 dropped) + **60 d (20%)** = **360.5 d ≈ 72.1 pw**.

## Owner decisions on the design

The owner took every recommendation except the floor run ("No to number 3, yes to everything else", 2026-11-13). Recorded in [ADR 0172](../../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md), which amends 0171 with the design's corrections:
1. **Reverb sends are post-fader** (follow the fader, mutes, duck, snapshot), as FMOD's sends default; one named golden.
2. **Estimate:** 300.5 d of tasks + a 20% reserve of 60 d = **360.5 d ≈ 72.1 pw**, no scope cut.
3. **No floor-conversion run:** floor µs stay estimates (0.6 ns per metered instruction); gates are set in instructions.
4. **The loudness ladder step goes first** and is skipped with master only.
5. **The target check is suspended** under monitor controls and Compare.
6. **Captures are labelled** (names and the `audio` section), said beside the Export checkbox.
7. **The built-in trigger:** F9, a one-second three-finger hold, 16 files.
8. **New level rules** start with RMS at −30 dBFS.

## Notes for the build

- `plan-milestone-build` works from API §11. The three parallel streams are the native core, the TypeScript mixer and recorder, and the editor.
- The bus goldens must keep their digests (R3); the only named new golden is the muted-bus-with-send case (R11).
- Raise the mixer size gate in `native/audio/build.mjs` with a build-log entry when M5-0 crosses it (R25).
