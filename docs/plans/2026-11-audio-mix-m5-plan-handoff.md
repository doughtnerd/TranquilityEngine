# Audio M5 (ADR 0171, amended by 0172): handoff to milestone planning

Written 2026-11-13, at the end of the session that ran steps 6–10 of the `design-subsystem` pipeline: the two-author technical design, the coordinator's verification, the owner's decisions, the write-back and this handoff. The previous handoff is [2026-11-audio-mix-m5-design-handoff.md](2026-11-audio-mix-m5-design-handoff.md).

**Next session:** `plan-milestone-build` on the design's task table (`docs/design/0171-audio-mix/api-and-models.md` §11), then `run-milestone-build`.

## Where things are

- **Branch:** `claude/loving-fermi-g98916`, pushed. Not yet merged to master; master's newest record is 0171, so **0172 is this branch's**. Check master again before allocating 0173.
- **Records:** [0171](../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md) (Accepted, direction) is **amended by [0172](../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md)** (Accepted 2026-11-13: the design's corrections and the owner's decisions; 0172 wins where they disagree). Index row in `docs/README.md`; status row in `docs/architecture/implementation-status.md`.

| Path | What it holds |
|---|---|
| `docs/design/0171-audio-mix/README.md` | the design index: documents and owners, how it was made, the verification table, the owner's decisions, notes for the build |
| `docs/design/0171-audio-mix/architecture.md` | the architect's: components, lifecycles, sequences, the stream and clock, the recorder ring, CPU counters, loudness flow, the seven gain lanes, post-fader sends, the dip and its late-batch rule, the slot table, sidechain and bus order, the ladder step, **constants (§5.3)**, memory (§6), **cost model (§7)**, failure modes, platforms |
| `docs/design/0171-audio-mix/api-and-models.md` | the senior engineer's: public API, settings, byte-exact wire (ABI 4.0), the capture file, `MixOp`, slot table, the `onSectionChanged` hook, editor models, layout, test plan, **the task table (§11)** |
| `docs/design/0171-audio-mix/rulings.md` | R1–R25 (the coordinator's rulings between the documents) |
| `docs/design/0171-audio-mix/contracts-*.md`, `review-round2-*.md`, `BRIEF.md` | contracts C1–C27 and S1–S14 (all closed), the cross-reviews, the authors' brief |
| `docs/design/0162-audio-spatial/working-notes.md` | **the owner's working rules, which still apply:** no runs that can't change a decision; follow industry standards; no feature flags; intensive tests at wave end and milestone end |

## Read in this order

1. ADR 0172 (short), then 0171's glossary and "Owner decisions (accepted)" including the UI/UX note.
2. `docs/design/0171-audio-mix/README.md`.
3. `api-and-models.md` §11 (the task table, the reserve, the critical path) and §10 (the test plan).
4. `architecture.md` §5.3 (constants) and §7 (the cost model), then the sections a wave touches.
5. `rulings.md` when a task's text cites R-n.
6. For shape: M4's plan and build log (`docs/design/0166-audio-music/build-log.md`, including the coordinator's retrospective).

## Settled (don't reopen)

- **Scope and 0171's revision 2**, as in the previous handoff's "Settled" list, read with 0172's corrections.
- **The design (0172 §1–2):** seven gain lanes; asap bus ramps bit-identical (every existing bus golden keeps its digest), `BUS_MIX` retired, ABI 4.0; asap fader edits (10 ms drags, 5 ms toggles, ≤ 50 ms gate on the audio clock); one stamped batch per structural dip with a `sequenceId` and the whole-sequence shift when late; `BUS_SLOT` for per-slot changes; silent-root tombstones; live adds deferred, never refused; any level-rule cycle refused (≤ 8 level rules, 32 in all); presence ducking in the core in M5-0; the hook `editor.project.onSectionChanged`; taint from monitor controls and Compare only; the CPU window on main (`loadPermille` 0 on the wire); STATUS 17,824 of 20,480 B; keyframes each second of rendered frames; one Worker decoder; captures capped at 64 MiB decompressed; 16-file trigger rotation.
- **Owner decisions (2026-11-13):**
  1. reverb sends are **post-fader**;
  2. **300.5 d of tasks + 20% reserve (60 d) = 360.5 d ≈ 72.1 pw**, no scope cut;
  3. **no floor-conversion run**: floor µs stay estimates (0.6 ns per metered instruction) and metered gates are set in instructions;
  4. the loudness ladder step goes first, skipped with master only;
  5. the target check is suspended under monitor controls and Compare;
  6. captures are labelled (names and the `audio` section), said beside the Export checkbox;
  7. the trigger: F9, a one-second three-finger hold, 16 files;
  8. new level rules start RMS at −30 dBFS.

## Gotchas found

- **The engine's audio code lives in `src/plugins/audio/`** (`runtime/core/coreBackend.ts`, `runtime/core/context.ts`, `worklet/coreDriver.ts`), not `src/engine/audio/`; the mixer is `src/engine/audio/mixer.ts`.
- **The recorder's copy must sit between the decode and the RECYCLE** in `CoreLink.handleMessage` (`runtime/core/context.ts:239-247`): the buffer goes back to the worklet right after.
- **Tests hard-code the old STATUS size:** `runtime/core/mirror.test.ts:133,141`, `runtime/core/bufferPool.test.ts:96`, `runtime/wire.m4.test.ts:200` (task Wa2).
- **The mixer wasm will pass its size gate:** 319,799 B today, ≈ 347–351 KB projected, against `MIXER_LIMIT = 320 * 1024` (`native/audio/build.mjs:27`). Raise it with a build-log entry (CLAUDE.md); don't cut.
- **ADR 0147 is Proposed:** the hook's amendment is a section appended to it (task Hk1), not a new record.
- **Post-fader sends change existing sound** for a bus with a send that is muted or not at gain 1: one named new golden; every other bus golden must keep its digest.
- **The samples use `fadeTo`** (flappy `GameManager.ts:17`, sound-lab `Buses.ts:17`, stress `Stress.ts:208`) and change behaviour under the authored/runtime split (task Sa1).
- **Environment:** the design authors ran in worktrees under `.claude/worktrees/`; the session's stop hook demands commits, so build agents should too. Mermaid renders headless with `mermaid@10.9.1` installed from npm into a scratch folder (CDNs are blocked). The documentation hosts (ITU, EBU, Audiokinetic, FMOD docs) are blocked by the proxy.

## Open

- **Owner:** from M4, the listening-pass sign-off and the deferred real-device items (0169); the lab-VM runs.
- **Unverified (reserve items RS1–RS10 hold their fixes):** real devices; Firefox and WebKit worklet clocks; the game loudness targets; true peak against BS.1770 Annex 2 and the EBU files; capture sizes and recorder cost on real scenes through the real core (bench Bn2); the main-to-worklet latency of a live edit (Fg1); the compressor click's cause; getting a file off Android; floor µs (by the owner's decision, estimates throughout).

## Next step

Run `plan-milestone-build` from this branch on `api-and-models.md` §11:
- milestones M5-0 → M5a → M5b → M5c → M5d (57 / 97.5 / 45.5 / 71 / 29.5 d);
- three parallel streams per milestone: the native core, the TypeScript mixer and recorder, the editor;
- waves on disjoint files with a collision audit (the hot files are `coreBackend.ts`, `mixer.ts`, `bus.rs`, `due.rs`, `schema/`), single-writer files for the wire (`Wa1` writes the whole M5 layout once at M5-0's head);
- intensive tests at each wave end and milestone end (the owner's rule), the milestone exit checks in API §10;
- write the plan in `docs/plans/`.
