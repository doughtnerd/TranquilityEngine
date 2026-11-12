# Audio M5 (profiler and live mix, ADR 0171): handoff to the technical design

Written 2026-11-12, at the end of the session that ran steps 1–5 of the `design-subsystem` pipeline:
1. the goal interview;
2. the survey and spikes;
3. the record;
4. the persona RFC round;
5. the owner's acceptance.

**Next session:** steps 6–10.
- **Step 6** is the two-author technical design. An architect writes the architecture; a senior engineer writes the API, models and a task table. They exchange numbered contracts, and the senior engineer owns the wire, settings and file formats.
- **Then:** coordinator verification, the owner decision list, writing the answers back, and the handoff to `plan-milestone-build`.

## Where things are

- **Branch:** `claude/loving-fermi-g98916`. It merged `origin/master` at `10f8de8` and again after ADR 0170 (F-37's ladder recovery), then added M5's work. **None of M5's design is on master yet.** Merge it to master when the owner agrees, before any build, so build worktrees (which start at master) see it.
- **Record numbers:** 0170 went to the shedding-ladder fix the same day. **0171 is M5's.** Check master again before allocating the next number.

| Path | What it holds |
|---|---|
| `docs/design/0171-audio-mix/goal.md` | the owner-confirmed goal, scope, reach, constraints, and today's values with code citations (one row corrected after S4: bus ramps are one frame interval, 5–50 ms) |
| `docs/decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md` | the record, **Accepted**. "RFC round (revision 2)" and "Owner decisions (accepted)" at its end win over the text above them |
| `spikes/audio-mix/README.md` | the answers, design consequences, proposed budgets and the unverified list. Sub-spikes: `research/` (S0), `loudness/` (S1), `cpu-clock/` (S2), `capture/` (S3), `mix-core/` (S4). `timed-runs.sh` and `timed-runs.log` hold the idle-machine runs |
| `docs/rfc/0171/` | the five reviews (architect, senior, junior, mixer, challenger) and the shared brief |
| `docs/design/0162-audio-spatial/working-notes.md` | **the owner's working rules, which still apply:** no runs that can't change a decision; follow industry standards; no feature flags; intensive tests at wave end and milestone end |

## Read in this order

1. The record: its glossary and "Decision", then "RFC round (revision 2)" (35 numbered changes) and "Owner decisions (accepted)", including **the owner's UI/UX note**.
2. `goal.md`.
3. `working-notes.md` (0162's) and the design-subsystem skill's `references/technical-design.md`.
4. `spikes/audio-mix/README.md`, then the sub-spike READMEs each author needs:
   - the architect: S2 (`cpu-clock`), S3 (`capture`), S4 (`mix-core`);
   - the senior engineer: S0 (`research`), S1 (`loudness`), S3 for the file format.
5. For shape: M4's design docs (`docs/design/0166-audio-music/architecture.md`, `api-and-models.md` with its §10 task table, `rulings.md`, `contracts-*.md`), which this design should mirror.

## Settled (don't reopen)

- **Scope** (owner): the profiler with capture files from exports; loudness on master plus up to 8 chosen buses with per-platform targets that warn and never adjust; live mixing whose edits are kept; signal-driven ducking and stamped bus ramps. The live editor↔game link is roadmap.
- **The record's revision 2,** in brief:
  - the stream is (epoch, frame, seq)-stamped, with raw STATUS blocks, main events with reasons, keyframes keyed on the STATUS count, and EPOCH and gap records;
  - captures carry the `audio` section and mix operations, are refused on another wire, and are untrusted input;
  - the CPU figure comes from cumulative counters in STATUS, with windows formed by quantum count;
  - the master meter sits after the reverb return and the limiter;
  - `meter: "loudness"`, `audio.loudnessTargets`, and `Bus.loudness` as a stable object;
  - one gain lane per factor in the core, ducking modes combined by min;
  - `Bus.volume` is the runtime multiplier and `Bus.authoredVolume` the authored value;
  - edits travel as operations through `mixer.apply`, with a session slot table and tombstones;
  - `editor.project.changed` amends 0147;
  - structural edits dip their subtree for 20 ms;
  - the Mixer panel's mute and solo are monitor controls, with a `tainted` flag on readings;
  - session controls, "Compare with Play start", and a ≤ 50 ms fader gate;
  - the ducking format has a required `mode` and a pre-fader sidechain tap;
  - presence ordering lands in M5-0, level mode in M5c;
  - bus ramps are a third stamped class in `due.rs`;
  - STATUS grows to 20 KB;
  - a new first ladder step sheds non-master metering (amends 0162/0170);
  - budgets are also stated in metered instructions converted to 0169's floor.
- **Owner decisions (accepted 2026-11-12):**
  1. capture trigger: API plus the export option's key or gesture;
  2. the API works in every build, with the recorder loaded lazily;
  3. adb on Android debug builds, a share-sheet plugin later;
  4. targets console -24 ±2 / -1 dBTP and mobile -18 ±2 / -1 dBTP;
  5. the Mixer strip without effect editing;
  6. new ducking rules default to `level`;
  7. one snapshot at a time;
  8. ≈ 62–75 pw provisional.

  **These were accepted as the recommended answers, from a plain "sound fine".** If the owner revisits any of them, update the record's last section first.
- **The owner's UI/UX note:** the audio editor UI will be reworked for a sound designer's workflow. M5 decides behaviour, not placement. Views stay thin over pure models, and new UI registers through the SDK in one place. **Ask the owner** whether the rework comes before, alongside or after M5's editor tasks; the task table's editor rows depend on it.

## Gotchas found

- **STATUS is nearly full:** 16,192 of 16,384 B (`audio-wire/src/schema.rs:73-74`).
- **Bus indices are positions in `project.json`** (`coreBackend.ts:765-770`). The remap path, the bed plan, automation and the hard rebuild's replay (`busConfigWire`, `coreBackend.ts:794-801`) all assume it.
- **`mixer.configure` clears script state** (`mixer.ts:80-91`). The editor hands the play Engine a copy of the settings (`playMode.ts`), and no SDK hook carries saved edits into it.
- **Master's meter today is on the root bus,** before the reverb return and the limiter (`bus.rs:575, 586-600`).
- **`workUnits` is the last quantum only** (`counters.rs:392-393`). The STATUS cadence switches 6 ↔ 48 quanta without a reset (`coreDriver.ts:976-979`), and posts are skipped when the pool is empty (`:1020-1024`).
- **Frames restart at 0 on a context rebuild** (`clock.ts:116-122`). A rate rebuild changes the sample rate.
- **No host sends COOP/COEP** (`src/export/webBuild.ts:286`, `vite.config.ts`, `src-tauri/tauri.conf.json`), so SharedArrayBuffer timers are out.
- **The samples use `fadeTo`** (flappy `GameManager.ts:17`, sound-lab `Buses.ts:17`, stress `Stress.ts:208`), so the authored/runtime split changes their behaviour. Update them.
- **Methodology gaps to close in the design:**
  - S3's main-thread timings ran at load ≈ 2.0 after S2;
  - S2's truth was partly validated against `Date.now`;
  - the capture scenes were synthetic;
  - no end-to-end run of the real core with M5 added.
- **The true peak** reads +0.10 dB (libebur128's interpolator, not BS.1770 Annex 2's table). The EBU test files were never run (the ITU and EBU hosts are blocked).
- **Network:** the proxy blocks the documentation hosts (Audiokinetic, FMOD, Unity docs, Epic, ITU, docs.rs, crates.io's API). GitHub raw and index.crates.io work.
- **Environment:**
  - `npm ci` and `rustup target add wasm32-unknown-unknown` were needed in this container;
  - the cargo target dir for the spikes was in this session's scratchpad: set your own;
  - the stop hook asks for commits after each turn, so authors should work in their own worktrees and commit there.

## Open

- **Owner:**
  - merge this branch to master;
  - the timing of the UI/UX rework relative to M5;
  - from M4, the listening-pass sign-off and the deferred real-device items (0169);
  - the lab-VM runs.
- **Unverified (record and spike README):**
  - real devices;
  - Firefox and WebKit worklet clocks;
  - the game loudness targets;
  - true peak against Annex 2;
  - capture sizes on real scenes;
  - main-to-worklet latency for a live edit;
  - the compressor click's cause;
  - getting a file off Android.

## Next step

Run steps 6–10 of `design-subsystem` from this branch:
- **The architect writes** `docs/design/0171-audio-mix/architecture.md`:
  - the stream and its clock;
  - the recorder ring;
  - the CPU counters;
  - loudness data flow and integrity;
  - gain lanes and stamped bus ramps;
  - the slot table and the live-edit path, with rebuild replay;
  - sidechain and the bus sort;
  - the ladder step;
  - budgets (µs and instructions);
  - failure modes;
  - platforms.
- **The senior engineer writes** `docs/design/0171-audio-mix/api-and-models.md`:
  - the public API (`Bus.loudness`, `authoredVolume`, `Audio.capture`, capability flags);
  - the `audio` format changes with limits;
  - the capture file format;
  - the wire and ABI (STATUS 20 KB, new commands);
  - the SDK hook;
  - editor models (thin views, per the UI note);
  - the test plan (EBU goldens, click tests, capture round trip, fake-clock CPU test);
  - **the task table**, in the order M5-0 → M5a → M5b → M5c → M5d.
- They exchange contracts, cross-review and get rulings. The coordinator verifies, then brings the owner one decision list.
- Then `plan-milestone-build`.
