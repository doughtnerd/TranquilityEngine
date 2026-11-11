# Interactive music (M4, ADR 0166): handoff to the technical design

Written 2026-11-11, at the end of the session that ran steps 1–5 of the design pipeline:
1. the goal interview;
2. the survey and spikes;
3. the record;
4. the persona RFC round;
5. the owner's acceptance.

**Next session:** steps 6–10 of the `design-subsystem` skill.
- Step 6 is the two-author technical design: an architect writes the architecture, and a senior engineer writes the API, models and a task table. They exchange numbered contracts, and the senior engineer owns the wire, settings and file formats.
- Then come coordinator verification, the owner decision list, writing the answers back, and the handoff to `plan-milestone-build`.

## Where things are

- **Branch:** `claude/confident-tesla-yvrqy8`.
  - It merged `origin/master` at `e83af8c` (ADR 0163–0165 and the M3 follow-ups), then added M4's work. **None of M4's design is on master yet.**
  - Merge it to master when the owner agrees, before any build, so build worktrees (which start at master) can see it.
- **Record numbers:** master's newest record was 0165 when this branch merged it. **0166 is M4's.** Check master again before allocating the next number.

| Path | What it holds |
|---|---|
| `docs/design/0166-audio-music/goal.md` | the owner-confirmed goal, scope, constraints, and today's real values with code citations |
| `docs/decisions/0166-interactive-music-segments-transition-rules-and-a-heard-beat-clock.md` | the record, **Accepted**. "RFC round (revision 2)" and "Owner decisions (accepted)" at its end win over the text above them |
| `spikes/audio-music/README.md` | the measured answers and proposed performance targets. Sub-spikes: `research/` (S0), `streams-align/` (S1), `stream-throughput/` (S2), `beat-clock/` (S3), `cost/` (S4), `rhythm/` (S5). `timed-runs.sh` and `timed-runs.log` hold the idle-machine runs |
| `docs/rfc/0166/` | the five reviews (architect, senior, junior, composer, challenger) and the shared brief |
| `docs/design/0162-audio-spatial/working-notes.md` | **the owner's working rules, which still apply:** no runs that can't change a decision; follow industry standards; no feature flags; intensive tests at wave end and milestone end |

## Read in this order

1. The record: its glossary, "Decision", then "RFC round (revision 2)" and "Owner decisions (accepted)".
2. `goal.md`.
3. `working-notes.md` (0162's) and the design-subsystem skill's `references/technical-design.md`.
4. `spikes/audio-music/README.md`, then the sub-spike READMEs each author needs:
   - the architect: S1, S3, S4;
   - the senior engineer: S0, S2, S5, and `cost/` for the wire.
5. For shape: M3's design docs (`docs/design/0162-audio-spatial/architecture.md`, `api-and-models.md`, `rulings.md`), which show the architect and senior-engineer documents, the contracts and the task table this design should mirror.

## Settled (don't reopen)

- **Scope** (owner): the grid with tempo and metre changes, quantised transitions, transition segments, stingers, stems, playlists and beat callbacks.
- **The model:** "both, as one model". Free clip arrangement on a timeline is deferred.
- **Sync:** music-tight by default, plus a `rhythmMode` project setting.
- **The budget:** M4 gets its own allowance. Fallback is best effort on Babylon.
- **The decisions in the record and revision 2:**
  - music lives in `myco.audioevent@1`, with new nodes `segment`, `playlist` and `musicSwitch`, plus `transitions` and `stingers`;
  - nodes have ids and limits;
  - main plans and the core executes;
  - prime, then stamp, with the ack as a per-ring "primed" bit in STATUS;
  - the worker primes breadth-first;
  - a group gate in the core: stems start together or wait together, and rebuild and seek reopen the whole group;
  - in-voice stamped records (ramps and PLAY/STOP offsets) as **milestone M4-0**;
  - beat prediction on main (design A), with callbacks before `update` and coalesced after gaps;
  - rule precedence (specificity, then list order, then the nearest common parent's table);
  - pre-entry and post-exit, loop tails, alternative takes per stem, quantised parameter changes, `ifTooLate` for stingers;
  - visible failures in `Audio.debug().music`.
- **Owner decisions (accepted 2026-11-11):**
  1. musical positions (bar:beat:tick);
  2. music rings 8 / 12 / 16;
  3. music inside the mixed-voice cap;
  4. whole encoded files in the worker;
  5. component messages plus `handle.music`;
  6. ≈ 45–55 person-weeks provisional.

  **These were accepted as the recommended answers, from a plain "I accept".** If the owner revisits any of them, update the record's last section first.

## Gotchas found

- **Every stamped record splits the quantum for every live voice,** PLAY and STOP included (`native/audio/crates/audio-core/src/voices.rs:310-325`). S4 measured +538 µs native per split quantum. S4's README says stamped PLAY doesn't split; the code says it does.
- **The worker wraps loops, not the core** (`native/audio/crates/audio-core/src/stream.rs:72-73`).
- **`streamOpened` is posted before any chunk,** on the worker→main port; chunks go worker→worklet (`src/plugins/audio/runtime/decoder/streams.ts:312-315`). It is not a "primed" signal.
- **`pump` fills each stream depth-first** (`decoder/streams.ts:498-510`).
- **A hard rebuild relaunches each stream asap from its own playhead** (`src/plugins/audio/runtime/core/coreBackend.ts:1406-1422`). That is the permanent stem skew S1 found.
- **The decoder holds each stream's whole encoded file** (`native/audio/crates/audio-decode/src/lib.rs:270`).
- **`engine.Audio` runs in `lateUpdate`** (`src/plugins/audio/runtime/audioSystem.ts:125-129`). Beat dispatch needs an earlier step.
- **`libm::sqrtf` and `sinf` are 4.5× slower in wasm than natively** (S4 micro). Fade laws use a polynomial or a table. M3's `audio-dsp/src/ambisonic.rs:116` uses `libm::sqrtf` and may benefit from `core::arch::wasm32::f32_sqrt`. That is a side task, not M4.
- **S3's beat-clock timing must use a sliding-window truth fit** (`--window`). One line per 60 s run gave artefact errors (S3 README, "Confirming run").
- **The bench preset has 32 HRTF voices; the editor's high preset has 8.** S4 also measured this container ≈ 1.45× slower than the base in 0157's table, while the "reference = 2× container" factor is an assumption.
- **Network:** the proxy blocks documentation hosts (Audiokinetic, FMOD, Epic, MDN, docs.rs). GitHub raw works. Godot, Kira, MDN browser-compat-data, the Web Audio spec and vendored FMOD/Wwise headers were verified that way.
- **Environment:**
  - `node_modules` needed `npm ci` in this container;
  - the `wasm32-unknown-unknown` target needed `rustup target add`;
  - rustc here is 1.97, while the pinned 1.99.1 won't install, so metered counts run +1–4% over `baseline.json`;
  - S2's audio fixtures are regenerated by `fixtures.mjs` and git-ignored.
- **The stop hook** commits after each turn, so authors should work in their own worktrees and commit there (working-notes lesson 8).

## Open

- **Owner:**
  - merge this branch's M4 design to master;
  - the M3 listening pass and lab-VM benches (from the M3 handoff);
  - for M4, the 9 real-device measurements in `spikes/audio-music/rhythm/README.md` §8;
  - the phone prime lead;
  - the lab-VM run of the music scenes.
- **Unverified in the spikes:**
  - the phone;
  - the wasm decode factor in the real worker;
  - real-device latency and heard-frame accuracy;
  - cold fetch of 8 stems;
  - splicing across files at a different sample rate;
  - glitch risk at `latencyHint: 0`;
  - human tap spread;
  - the Wwise/FMOD manuals and Unreal Quartz.

## Next step

Run steps 6–10 of `design-subsystem` from this branch:
- **The architect writes** `docs/design/0166-audio-music/architecture.md`. It covers:
  - the music player;
  - the prime protocol and group gate;
  - the in-voice records;
  - recovery;
  - the clock;
  - rhythm mode;
  - budgets;
  - failure modes.
- **The senior engineer writes** `docs/design/0166-audio-music/api-and-models.md`. It covers:
  - the format with limits;
  - the API;
  - the wire and ABI changes;
  - settings;
  - the editor;
  - the test plan;
  - **the task table**.
- They exchange contracts, cross-review, and get rulings. The coordinator verifies, then brings the owner one decision list.
- After that comes `plan-milestone-build` on the task table, in the order M4-0 → M4a → M4b → M4c → M4d.
