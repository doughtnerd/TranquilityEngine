# 0167. Interactive music (M4): correct 0166 from the technical design (a stamped PLAY doesn't split the quantum, the prime lead, the allowances) and record the owner's design decisions

- **Status:** Accepted (2026-11-11)
- **Date:** 2026-11-11
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0166 (where this record and 0166 disagree, this record wins)
- **Related:** 0157 (stamped records, lookahead, budgets), 0158 (the event format), 0162 (the per-voice effects record), 0166

## Glossary

- **Stamped record:** a command to the audio thread that carries the exact audio frame it applies at.
- **Splitting the quantum:** rendering the audio thread's 128-frame block in pieces so a command can apply mid-block. Today a split re-renders *every* playing voice in pieces, which costs ≈ 0.5 ms (0166, S4).
- **Stem:** one layer of a piece of music (drums, bass, pads), played in step with the others.
- **Group:** the stems of one segment, started together by the core's gate (0166 revision 2).
- **Prime lead:** how far ahead of a grid point main must ask for a streamed segment, so its stems are buffered in time for a sample-exact start.
- **Reserve:** schedule set aside for work the task table can't foresee.

## Context

The technical design for 0166 ([docs/design/0166-audio-music/](../design/0166-audio-music/README.md)) was written by an architect and a senior engineer, cross-reviewed, ruled on and verified against the code. It found three statements in 0166 that are wrong or can't work, and the owner decided six questions the design raised.

0166 is Accepted, and this project doesn't rewrite accepted records (CLAUDE.md), so the corrections and decisions are recorded here.

## Decision

### 1. Corrections to 0166

1. **A stamped PLAY doesn't split the quantum.** 0166's revision 2 said every stamped record splits it, PLAY included. That is wrong, and spike S4 was right.
   - PLAY writes its voice slot at once, and the voice starts at its sample offset inside the block (`native/audio/crates/audio-core/src/scheduler.rs:38-40, 218-221`; `voices.rs:375-396`).
   - What splits are the **queued per-voice records**: STOP, SET_PARAMS, FADE, SET_PAUSED, SEEK, SET_LOOP and SET_VOICE_FX (`voices.rs:310-325`).
   - **M4-0 therefore applies every queued per-voice record inside its own voice:**
     - gain-like records (FADE, gain-only SET_PARAMS, STOP) by a start-sample compare in the voice's gain loop;
     - the others by splitting that voice's render only.
   - Records that aren't per voice (bus, master, listener, configuration tables) still split, and a counter shows it.
   - M4-0 has a consumer outside music: every stamped play of a spatial voice with non-default effects sends its SET_VOICE_FX at the same frame (`src/plugins/audio/runtime/core/coreBackend.ts:1458-1459`), so it splits a quantum today.
2. **The prime lead is 1.25 Ê + L + Δ̄,** not max(horizon, 1.25 × EMA).
   - Ê is the measured group prime time: an EMA from the prime request to the batch that sees every primed bit, seeded at 40 ms and not sampled while the tab is hidden.
   - L is the lookahead.
   - Δ̄ is the mean display-frame interval.
   - 0166's formula didn't leave room for its own deadline, T − L − one display frame.
   - The first lead is still ≈ 100 ms at 60 Hz.
3. **The worst-case allowances on default and low become 0.08 / 0.06 ms** (were 0.06 / 0.04). They were sized for the old 8 and 4 rings; 0166 gave music 12 and 8.
   - High's allowances come from S4's measured deltas divided by the measured container factor of 1.45, not the assumed 2×. Default's and low's are modelled (est.).
   - These are tripwire moves, recorded in the build log (CLAUDE.md). Preset totals don't grow, because music counts inside the voice cap (0166 owner decision 3).

### 2. Design rulings 0166 now reads with

These were settled in the design ([rulings.md](../design/0166-audio-music/rulings.md), R1–R24) and change or sharpen 0166's text:
- **Crossfades run on the voice's `fade` ramp, not `gain`,** so a crossfade and a stem's parameter automation don't fight over one ramp.
  - A fade-in is a PLAY that starts silent, then a stamped FADE with a law (linear, S-curve, equal power) and a start phase.
  - The laws run at control rate, never `libm` per sample.
- **The primed bit in STATUS carries the ring's epoch,** so a re-planned group can't be stamped on a stale bit. The core's group table has 16 entries.
- **A stem that runs dry mid-piece holds its whole group:**
  - every stem fades out over 5 ms;
  - all of them resume together at one offset once all have data;
  - the core gives up after 1 s, and main re-plans.
  - This is the project's own design: the middleware surveyed treats starvation as a fault, and its handling is unverified here.
- **A held group's stamped records are rebased by its slip,** so fades stay on the music.
- **The worker keeps a music instance's encoded files,** refcounted by path, within a per-preset budget of 48 / 96 / 160 MiB (est.).
  - Playing, primed and likely-next files are protected.
  - This refines 0166 owner decision 4.
- **Bridges ≲ 30 s and loop tails are decoded clips,** not streams.
- **Every music change is stamped in both modes. Rhythm mode refuses nothing:** 0166 §6's "asap music changes are refused" is withdrawn, because none exist.
  - Rhythm mode adds stamped recovery and holds callbacks during recovery.
- **`Audio.timeAt` is the raw heard-clock map.** Calibration is subtracted only in `positionAt`'s judged offset.
- **The early frame step is the built-in system `engine.AudioMusic`,** in `update` before `engine.UpdateScripts`.

### 3. The owner's design decisions (2026-11-11)

1. **The reserve is 20%.** No scope cuts are taken.
   - The estimate is **≈ 69.7 person-weeks**: 290.5 days of tasks plus a 58-day named reserve.
   - This replaces 0166's provisional 45–55.
   - The critical chain is ≈ 22 weeks if nothing waits, with at least two senior engineers.
2. **No pitch on music.** Pitch automation on music tracks is refused by validation, and `pitch` on `AudioSource` and `EventOptions` is ignored for music instances, with a warning. The beat clock and loop prediction need a fixed rate. Wwise music tracks don't pitch either.
3. **`handle.onMusic(kind, fn)`** delivers beat, bar and cue callbacks to scripts that play music without a node. It sits alongside 0166's component messages and is delivered in the same step. This is how Wwise (`AK_MusicSync*` on the playing instance) and FMOD (`TIMELINE_BEAT` on the event instance) deliver them.
4. **A public music seek:** `handle.music.seek(position)`, with a musical position. Wwise (`SeekOnEvent`) and FMOD (`setTimelinePosition`) have it too.
5. **A hidden tab under `audio.background: mute` commits ahead, as under `play`,** so the music keeps its place. This replaces 0166 revision 2 item 8's "with `mute` it re-plans on resume". Wwise and FMOD resume in place after a suspend.
6. **The starve group hold** (§2) stands.

## Alternatives considered

- **Revise 0166 in place (a revision section), as M3 did with 0162.** Not chosen: CLAUDE.md says accepted records aren't rewritten, and the owner chose this amending record.
- **Fold M4-0 into M4b** (curved fades through today's queue, one split per transition, ≈ 7–11 days saved). Not chosen:
  - music splits more often than once per transition (bar-quantised ramps, loop tails, hand-overs);
  - stamped spatial plays split today;
  - the owner had already made M4-0 its own milestone.
- **A third as the reserve (≈ 77.5 person-weeks).** Not chosen: the 20% column keeps the three largest risks whole (real-device clock and prime lead, editor rework after a composer trial, wave-end integration), and M3 drew none of its reserve.
- **When one stem starves, let it drop out and resync at the next bar.** Not chosen: the resync needs a second set of rings exactly when the worker is slow.

## Consequences

**Positive**
- M4-0 is smaller than 0166 implied (PLAY needs no work), and it fixes stamped spatial plays as well as music.
- The planner's lead can meet its own deadline.
- Scripts get the same per-instance callbacks and seek that Wwise and FMOD users expect.

**Negative / costs**
- The estimate is ≈ 69.7 person-weeks against 0166's provisional 45–55. The main-side player alone is ≈ 13 person-weeks against 0166's 4.
- Music can't be pitched.
- When a stem starves, the whole music group dips for a moment.

## Deprecates

- 0166's statement that a stamped PLAY splits the quantum.
- Its lead formula.
- Its default and low worst-case allowances.
- Rhythm mode's refusal of asap changes.
- "Re-plan on resume" under `mute`.
- The provisional 45–55 person-week estimate.

## Open questions

The owner's runs remain open:
- the phone prime lead;
- real-device latency and heard-frame accuracy (`spikes/audio-music/rhythm/README.md` §8);
- the lab-VM run of the music scenes;
- the listening pass.

## References

- Design: [docs/design/0166-audio-music/README.md](../design/0166-audio-music/README.md), with `architecture.md`, `api-and-models.md` (task table §10) and `rulings.md`.
- Spikes: [spikes/audio-music/README.md](../../spikes/audio-music/README.md), and `cost/` (S4) for splits and allowances.
- Survey: `spikes/audio-music/research/README.md` (the Wwise and FMOD callback headers).
