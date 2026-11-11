# 0166 interactive music (M4): technical design

The build-ready design for [ADR 0166](../../decisions/0166-interactive-music-segments-transition-rules-and-a-heard-beat-clock.md) (Accepted, direction). Read [goal.md](goal.md) and the record first, then these documents.

| Document | Owner | What it holds |
|---|---|---|
| [architecture.md](architecture.md) | architect | components and channels; lifecycles (the player, a group, a music ring); sequences (start, crossfade, bridge, stinger, `while`, late group, rebuild, hidden tab, seek, hot reload); the planner and lead; priming and the pool; the group table (gate, hold on starve, give-up); in-voice records; the beat clock; rhythm mode; **every constant** (§5.3); memory (§6); **the cost model** (§7); failure modes; observability; platforms; industry comparison; resolutions (§13) |
| [api-and-models.md](api-and-models.md) | senior engineer | public API; settings; the format (musical positions, nodes, limits, transitions, stingers, library, validation); internal models; byte-exact wire (PLAY gate, the `shape` word, STATUS sections, init and ABI 3.0, worker messages); native and TS layout; editor; Babylon; test plan; **the task table** (§10); resolutions (§12) |
| [contracts-architect.md](contracts-architect.md), [contracts-senior.md](contracts-senior.md) | each author | contracts C1–C19 and S1–S14 |
| [review-round2-architect.md](review-round2-architect.md), [review-round2-senior.md](review-round2-senior.md) | each author | cross-reviews |
| [rulings.md](rulings.md) | coordinator | R1–R24 and the owner list |

The owner's working rules from M3 still apply: [../0162-audio-spatial/working-notes.md](../0162-audio-spatial/working-notes.md).

## How it was made (2026-11-11)

1. **Round 1:** the two authors drafted in parallel, in separate worktrees, and wrote contracts. The senior engineer owned bytes, settings, the format and the API; the architect owned constants, timing, memory and failure behaviour. Both found independently that **a stamped PLAY doesn't split the quantum**, contrary to the record's revision 2.
2. **Round 2A:** each reviewed the other's documents. Both verdicts were "approve with changes":
   - the architect raised 7 major and 8 minor issues;
   - the senior engineer raised 1 blocking (the voice slot is full), 6 major and 9 minor.
3. **Rulings R1–R24:** issued in one batch, after checking the code claims both reviews rest on.
4. **Round 2B:** both revised and ended with resolutions tables. One relay followed, because my ruling R16 had no memory bound. The authors bounded it the same way independently, and the architect set the numbers.

## Coordinator verification

| Check | Result | Fix |
|---|---|---|
| Mermaid diagrams | 9/9 render (Mermaid 10.9.1, headless Chromium). The architect's report said 14 | — |
| Code citations | Checked against the code: `scheduler.rs:38-40, 218-221` and `voices.rs:375-396` (PLAY written at once, starts in-range); `voices.rs:310-325` (queued records split); `coreBackend.ts:1458-1459` (stamped SET_VOICE_FX with each stamped PLAY); `voices.rs:159` (FADE moves its own `fade` ramp); `voices.rs:149-150` and `layout.rs:29` (192 B slot, one spare byte); `voices.rs:754-760` (splice margin); `voices.rs:1394-1396` (STOP ends a SCHEDULED voice at once); `stream.rs:116` (5 ms starve fade); `schema.rs:72-74` (STATUS cadence); `lookahead.ts:45-53`; `clock.ts:148` (`beginFrame` idempotent); `background.ts:4-10`; `encodedCache.ts` (32 MB cap); the presets at `audioSettingsModel.ts:235-237` (64 / 128 / 256 mixed); and the system order (`UIDocument.ts:998` uses the same "after Lobby and PredictionSmooth, before UpdateScripts" slot) | all hold |
| Parked records | The architecture says 128 after the relay; the API still said 64, with a different overflow rule | The API, S11 and the regions now use 128 and the architect's overflow rule (applies at its own frame, unrebased, `parkedOverflow`). `Due` is 18,432 B, so the regions total **29,152 B** (was 26,080) in both documents and both contract files |
| Give-up timeout | The API carried a 2 s placeholder | 1 s, as the architecture sets it (§4.3, §5.3) |
| STATUS `musicRings` entry | Architecture §6 said 12 B; the API's layout is 8 B | 8 B; the worst case of 16,192 B (192 B spare) was already computed with 8 |
| S6 status | Marked "partly met" pending the architect's §6 | §6 was updated in 2B; now marked met |
| Duplicate heading | API §10.3 heading appeared twice | removed |
| Task table | Re-summed by script: 79 rows; M4-0 25, M4a 108, M4b 58, M4c 34, M4d 63 = **288 d** (S 99.5, M 162, J 26.5). Both reserve columns re-sum (96 and 58). The critical chain, summed per milestone, is 109.5 d. Every dependency names an existing task | matches the document |
| Numbers vs spikes | High allowances: S4's +43 / +99 µs native ÷ 1.45 = 30 / 68 µs, as in architecture §7. The first lead is 100 ms (Ê seed 40 ms; S1's 20–60 ms prime estimate). The splice needs ≥ 325 frames (S1 Q4) and the margin is 480 | — |
| Spot re-measurement | Not run. The one claim that moved during the design (a stamped PLAY doesn't split) is settled by the code, and no measured number changed. Per the owner's rule, no run that can't change a decision | — |
| Stale decisions | The record says PLAY splits; its lead formula is max(horizon, 1.25 × EMA); its default and low worst allowances are 0.06 / 0.04 ms | written back in [ADR 0167](../../decisions/0167-interactive-music-design-corrections-and-owner-decisions.md) (lead = 1.25 Ê + L + Δ̄; allowances 0.08 / 0.06 ms as tripwire moves) |

**Estimate, line by line:**
- the record's provisional 45–55 pw;
- round 1: 291 d of tasks + a 96 d reserve = 77.4 pw;
- round 2B: 288 d of tasks (−3 d: the architect's duplication cuts −21 d, then +18 d for the rows the rulings made firm: the voice-local split, span clips, the worker cache, the group hold and the slip rebase) + a reserve of **96 d (a third) = 76.8 pw**, or **58 d (20%) = 69.2 pw**;
- round 3 (owner decisions): **290.5 d** of tasks (+2.5 d: pitch validation in P6 +0.5, `handle.onMusic` K5 +0.5, public seek R7 +1.5) + the chosen **58 d (20%)** reserve = **348.5 d ≈ 69.7 pw**. Re-summed by script: 81 rows, M4-0 25, M4a 108.5, M4b 59.5, M4c 34.5, M4d 63.

After round 3 the two documents disagreed on one point: whether seek may name another segment. Ruling R25 settled it (seek stays within the playing segment, as in Wwise and FMOD).

## Owner decisions on the design (2026-11-11)

The owner accepted every recommendation (recorded in [ADR 0167](../../decisions/0167-interactive-music-design-corrections-and-owner-decisions.md) and at the end of [rulings.md](rulings.md)):
1. **Reserve:** 20%, with no scope cuts.
2. **Pitch:** none on music.
3. **Callbacks:** `handle.onMusic(kind, fn)` alongside the component messages.
4. **Seek:** a public `handle.music.seek(position)`.
5. **Hidden tab:** under `mute`, the music commits ahead and keeps its place.
6. **Starve:** the whole-group hold stays.
7. **Record:** the corrections go into ADR 0167, which amends 0166.

Before choosing, the owner asked whether the recommendations follow industry standards:
- items 2–5 follow Wwise and FMOD (item 2 follows Wwise; FMOD allows pitch and leaves sync to the user);
- item 6 is the project's own design;
- item 7 originally recommended an in-place revision, against CLAUDE.md and common ADR practice, and was changed to an amending record.

**Final figures:**
- 290.5 days of tasks plus a 58-day named reserve = 348.5 days ≈ **69.7 person-weeks** (0166's provisional figure was 45–55);
- the critical chain is ≈ 22 weeks if nothing waits, with at least two senior engineers;
- music's audio-thread cost on high (reference machine, est.): typical 30–43 µs, worst 68 µs;
- new core memory: 29,152 B on every preset, plus 2.3 / 3.5 / 4.7 MiB of music rings and a worker encoded-cache budget of 48 / 96 / 160 MiB (est.).

## Notes for the build

- **ABI 3.0**, since `myco_audio_init` gains `max_music_rings`, and **envelope 1.2**, since the `shape` word is appended. Regenerate `wire.generated.ts` and the schema hash.
- **M4-0 goes first.** Unstamped work must stay bit-identical against every M1–M3 golden. Stamped cases are re-recorded.
- **M4-0's exit check** is `splitQuanta` = 0 in the music scenes and in a scene of stamped spatial plays with sends.
- **Exit checks require stems to start on the stamp's sample.** Seam goldens null against the offline reference: 1e-5 against a reference evaluating the curve at the same points, 1e-4 against the exact curve.
- **M4a's pure-TypeScript tasks** (the format, the grid) and the editor's Ed1 may start alongside M4-0.
- **Tripwire moves to record in the build log:** the mixer +10–14 KB (est.) from 265,952 B against 320 KB; the default and low worst allowances 0.08 / 0.06 ms.
- **The listening pass, the lab-VM runs and the phone measurements** (`spikes/audio-music/rhythm/README.md` §8; the phone prime lead) are the owner's.

## Plan seams (build plan, 2026-11-11)

The build plan ([waves](../../plans/2026-11-audio-music-m4-waves.md), [tree](../../plans/2026-11-audio-music-m4-tree.md)) adds these files to the layout of `api-and-models.md` §5–§7, so parallel tasks own whole files. Each one's contract is in the waves plan's "Contracts" table.

| File | Why | Writer |
|---|---|---|
| `audio-core/src/voice_split.rs` | class S voice-local split, called from `voices.rs` (hook H1), so Z2b and Z2c don't share `voices.rs` | Z2c |
| `audio-core/src/group_hold.rs`, `group_rebase.rs` | the starve hold and the slip rebase, called from C2b's hooks (H2), so C2c and C2d don't share `groups.rs` or `due.rs` | C2c, C2d |
| `audio-dsp/src/curve_laws.rs`, `equal_power.rs`, `native/audio/tools/gen-equal-power/` | the curve laws at control rate and the checked-in 1,024-point table §5 describes | Z2b (leaves) |
| `runtime/core/musicOps.ts` | the core backend's group operations (§4.6), outside `coreBackend.ts` | Q2 (wiring), P1 |
| `runtime/decoder/musicGroups.ts`, `musicCache.ts` | the worker's group lifecycle and the refcounted encoded cache (R16), outside `streams.ts` (H3) | D1a, D1b, D1c |
| `runtime/music/seek.ts` | the public seek (R7) on R3a's `planImmediate` (H5) | R7 |
| `runtime/music/playlistOrder.ts`, `stingerPolicy.ts` | pure selection and `ifTooLate`/`dontRepeat` tables | P4, R5 (leaves) |
| `editor/music/index.ts`, `peaksMip.ts`, `segmentSnap.ts`, `tempoTools.ts`, `ruleLint.ts`, `importHints.ts` | panel registration (H6) and pure helpers split from the views | Ed2, Ed1, Ed3, Ed4, Ed7, Ed9 |
| `tests/e2e/audio-music-smoke.spec.ts`, `audio-music-listening.spec.ts` | the end-to-end smoke from wave 1, and the walker for the owner's listening sections | S0, E1–E3, Ed11, L1 |
