# Interactive music (M4, ADR 0166 + 0167): handoff to milestone planning

Written 2026-11-11, at the end of the session that ran steps 6–10 of the design pipeline:
- the two-author technical design;
- coordinator verification;
- the owner's decisions;
- writing them back;
- this handoff.

**Next session:** `plan-milestone-build` on the design's task table, in the order M4-0 → M4a → M4b → M4c → M4d. Then `run-milestone-build`.

## Where things are

- **Branch:** `claude/eloquent-newton-v9xofb`.
  - It started at master's `57015af` (ADR 0166 accepted, already on master) and adds the whole technical design and ADR 0167.
  - **None of it is on master yet.** Merge it to master when the owner agrees, before any build, because build worktrees start at master.
- **Records:**
  - 0166 is Accepted.
  - **0167** (Accepted 2026-11-11) amends it. It holds the corrections from the design and the owner's design decisions, and it wins where the two disagree.
  - Master's newest record was 0166 when this was written. Check master again before allocating 0168.

| Path | What it holds |
|---|---|
| `docs/design/0166-audio-music/README.md` | **Start here.** The index, how the design was made, the coordinator's verification table, the owner's decisions, final figures and notes for the build |
| `docs/design/0166-audio-music/architecture.md` | the architect's document: components, lifecycles, sequences, the planner and lead, priming, the group table, in-voice records, the beat clock, rhythm mode, **constants (§5.3)**, memory (§6), the cost model (§7), failure modes, observability, platforms, industry comparison, resolutions |
| `docs/design/0166-audio-music/api-and-models.md` | the senior engineer's document: public API, format and limits, internal models, byte-exact wire, layout, editor, Babylon, test plan, **the task table (§10)**, owner items (§11), resolutions (§12) |
| `docs/design/0166-audio-music/contracts-architect.md`, `contracts-senior.md` | contracts C1–C20 and S1–S14, each with its final status |
| `docs/design/0166-audio-music/rulings.md` | coordinator rulings R1–R25, the owner list and the owner's answers |
| `docs/design/0166-audio-music/review-round2-*.md` | the cross-reviews |
| `docs/decisions/0167-interactive-music-design-corrections-and-owner-decisions.md` | the amending record |
| `docs/design/0162-audio-spatial/working-notes.md` | **the owner's working rules, which still apply:** no runs that can't change a decision; follow industry standards; no feature flags; intensive tests at wave and milestone end |

## Read in this order

1. ADR 0166's glossary and "Decision", then its "RFC round (revision 2)" and "Owner decisions (accepted)". Then **ADR 0167** in full.
2. `docs/design/0166-audio-music/README.md`.
3. `api-and-models.md` §10 (the task table) and §9 (the test plan).
4. `architecture.md` §5.3 (constants) and §8 (failure modes), plus any section a task row cites.
5. `working-notes.md` (0162's), and the `plan-milestone-build` skill.
6. For shape: M3's plans, `docs/plans/2026-11-audio-spatial-m3-waves.md` and `docs/plans/2026-11-audio-spatial-m3-tree.md`.

## Settled (don't reopen)

Everything in 0166's revision 2 and owner decisions, and everything in 0167. In particular:
- **M4-0 is its own first milestone.** It applies every queued per-voice stamped record inside its voice:
  - class G: FADE, gain-only SET_PARAMS and STOP, by a compare in the gain loop;
  - class S: every other per-voice record, including SET_VOICE_FX, by a voice-local split.

  A stamped PLAY needs no work (0167 §1.1). The exit check is `splitQuanta` = 0 in the music scenes and in a scene of stamped spatial plays with sends.
- **The wire:**
  - ABI 3.0 (`myco_audio_init` gains `max_music_rings`) and envelope 1.2;
  - a `shape` word (law and start phase) on FADE, SET_PARAMS and STOP;
  - PLAY gains `fadeZero` and a 10-bit group id with a 6-bit size;
  - STATUS gains `musicRings` with an epoch and one `groupStarts` item per group: worst case 16,192 B, 192 B spare.
- **Core regions:** `Due` 18,432 B (256 due + 128 parked records), `Curves` 8,160 B (255 entries), `Groups` 2,560 B (16 entries) = **29,152 B on every preset**. The voice slot stays 192 B.
- **Crossfades run on the `fade` ramp.** Curve laws run at control rate, never `libm` per sample.
- **The group gate:**
  - a group starts together or waits together;
  - a stem that starves holds the whole group (5 ms fades);
  - the core gives up after 1 s;
  - a held group's records are rebased by the slip.
- **The prime lead is 1.25 Ê + L + Δ̄** (Ê seeded at 40 ms, so the first lead is 100 ms). An `at` closer than the lead goes to the next grid point.
- **The worker's encoded cache is per instance and refcounted,** with a budget of 48 / 96 / 160 MiB (est.). Bridges ≲ 30 s and loop tails are decoded clips.
- **`engine.AudioMusic`** runs in `update`, before `engine.UpdateScripts`.
  - `Audio.timeAt` is raw; calibration applies only in `judged`.
  - Every music change is stamped, and rhythm mode refuses nothing.
- **The owner's design decisions (0167 §3):**
  - a 20% reserve and no scope cuts;
  - no pitch on music (a validation error);
  - `handle.onMusic(kind, fn)`;
  - a public `handle.music.seek(to: string)` within the playing segment (R25);
  - `mute` under a hidden tab commits ahead, as under `play`;
  - the starve group hold.
- **The estimate:** 290.5 d of tasks (M4-0 25, M4a 108.5, M4b 59.5, M4c 34.5, M4d 63) + a 58 d named reserve = 348.5 d ≈ **69.7 pw**.
  - The critical chain is ≈ 109.5 d (≈ 22 weeks if nothing waits).
  - Two senior engineers are the floor. The core, player and clock chains shouldn't share one person.

## Gotchas found

- **Queued records split the quantum for every live voice** (`native/audio/crates/audio-core/src/voices.rs:310-325`). PLAY doesn't (`scheduler.rs:38-40, 218-221`). Today every stamped spatial play with non-default effects splits a quantum through its SET_VOICE_FX (`src/plugins/audio/runtime/core/coreBackend.ts:1458-1459`).
- **FADE moves the voice's own `fade` ramp,** a multiplier that starts at 1 (`voices.rs:159`), not `gain`.
- **The voice slot is 192 B with one spare byte** (`voices.rs:149-150`, `layout.rs:29`). Don't grow it.
- **Main's encoded cache is capped at 32 MB** (`src/plugins/audio/runtime/core/encodedCache.ts`), which is why the worker keeps music files (R16).
- **`beginFrame` is idempotent at the same rAF time** (`core/clock.ts:148`). That is what lets `engine.AudioMusic` call it early.
- **The 0166-era gotchas still hold:**
  - the worker wraps loops (`stream.rs:72-73`);
  - `streamOpened` isn't a primed signal (`decoder/streams.ts:312-315`);
  - `pump` fills depth-first (`:498-510`);
  - a hard rebuild relaunches streams one by one (`coreBackend.ts:1406-1422`);
  - `libm` `sqrtf` and `sinf` are 4.5× slower in wasm.
- **Agent environment:**
  - author agents worked in their own worktrees and committed there, and the coordinator merged (working-notes lesson 8);
  - the Mermaid renderer and the task-table re-sum were scratch scripts (headless Chromium with the npm `mermaid` 10.9.1, plus a Python row parser), and are easy to recreate.
- **This container:**
  - rustc is 1.97 against the pinned 1.99.1, so metered counts run +1–4% over `baseline.json`;
  - `npm ci` and `rustup target add wasm32-unknown-unknown` may be needed.

## Open

- **Owner:**
  - merge this branch to master;
  - the M3 listening pass and lab-VM benches;
  - for M4, the 9 real-device measurements in `spikes/audio-music/rhythm/README.md` §8, the phone prime lead, the lab-VM run of the music scenes, and the listening pass (an exit check per milestone).
- **Tripwire moves to record in the build log when they happen:**
  - the mixer: +10–14 KB (est.) from 265,952 B, against the 320 KB tripwire;
  - the worst-case allowances for default and low: 0.08 / 0.06 ms.
- **Unverified:**
  - the phone;
  - the wasm decode factor in the real worker;
  - real-device latency and heard-frame accuracy;
  - cold fetch of 8 stems;
  - glitch risk at `latencyHint: 0`;
  - human tap spread;
  - the Wwise and FMOD manuals (the documentation hosts are blocked);
  - how middleware handles a starved stem.
- **A side task, not M4:** M3's `audio-dsp/src/ambisonic.rs:116` uses `libm::sqrtf`, which may benefit from `core::arch::wasm32::f32_sqrt`.

## Next step

Run `plan-milestone-build` on `api-and-models.md` §10:
- milestones M4-0 → M4a → M4b → M4c → M4d;
- waves on disjoint files: `voices.rs`, `scheduler.rs`, `eventRuntime.ts` and the wire schema are the single-writer hot spots;
- leads write skeletons, and cheaper models fill the leaves;
- write the plan to `docs/plans/2026-11-audio-music-m4*.md`.

M4a's pure-TypeScript tasks (the format, the grid) and the editor's Ed1 can run alongside M4-0.
