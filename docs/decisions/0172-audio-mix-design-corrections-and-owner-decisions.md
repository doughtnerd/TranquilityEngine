# 0172. Audio M5: correct 0171 from the technical design (seven gain lanes, raw capture sizes, the sort's real benefit, the hook's name) and record the owner's design decisions

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0171 (where this record and 0171 disagree, this record wins)
- **Related:** 0097 (ducking rules), 0147 (the editor SDK), 0157 (stamped records, budgets), 0158 (bus automation), 0162 and 0170 (the shedding ladder), 0169 (the mobile floor), 0171

## Glossary

- **Gain lane:** one of the factors the core multiplies to get a bus's gain. Each lane ramps on its own, so a fade, a duck and a mute don't fight over one value.
- **Pre-fader / post-fader send:** a send taken before the bus's volume and mute (it keeps feeding the reverb when the bus is turned down or muted) or after them (it follows them).
- **Dip:** the 20 ms fade-out and fade-in of a bus subtree around a structural live edit, so the change can't click.
- **Stamped / asap:** a command that applies at an exact audio frame, or as soon as the audio thread reads it.
- **Tripwire:** a size or speed gate the project keeps against accidental growth. Going over one is raised and recorded in the build log, not a reason to cut (CLAUDE.md).
- **Floor conversion:** the factor that turns a count of metered wasm instructions into microseconds on the supported low-end phone (0169).

## Context

The technical design for 0171 ([docs/design/0171-audio-mix/](../design/0171-audio-mix/README.md)) was written by an architect and a senior engineer, cross-reviewed, settled by rulings R1–R25 and verified against the code. It found statements in 0171 that are wrong or under-specified, and the owner decided eight questions it raised (2026-11-13). 0171 is Accepted and isn't rewritten (CLAUDE.md), so the corrections and decisions are recorded here.

## Decision

### 1. Corrections to 0171

1. **The trigger-first sort doesn't fix a presence-mode delay** (change 26). Presence ducking is decided on main from voice counts (`mixer.ts:200-213`), so bus order can't delay it. The sort still lands in M5-0, as level mode's groundwork. Presence ducking itself moves into the core in M5-0, with `BUS_PRESENCE` stamped at the voice's frame, so a presence duck starts on the sound's own frame. Presence rules add no sort edge; only level rules do.
2. **Capture sizes** (change 3, §7). 0171's "0.08 / 0.15 / 0.25 MB per minute saved" is spike S3's delta-encoded figure, stale since change 2 chose raw STATUS. A saved minute is **0.27 / 0.84 / 2.45 MB** at 64 / 256 / 1,024 voices (`spikes/audio-mix/capture/README.md:29-33`, synthetic, est.). With M5's STATUS growth, a 16 MiB ring holds about 7 minutes at 64 voices (est.).
3. **Seven gain lanes, not five** (change 15): `authored` (authored volume and mute), `runtime` (script volume, fade and mute), `snapshot`, `monitor` (the Mixer panel's mute and the solo gate), `dip` — written by main — and `duck`, `automation`, owned by the core. A lane that isn't moving costs nothing. An asap ramp on one lane uses today's `Ramp::next` arithmetic, so **every existing bus golden keeps its digest**; `BUS_MIX` is retired (ABI 4.0).
4. **The fader gate uses asap edits, not stamped ones** (change 21). A stamp waits the lookahead, 67 ms at 30 fps (`lookahead.ts:27-31`), which can't meet ≤ 50 ms. Drags ramp over 10 ms and toggles over 5 ms, posted at once (at most one post per 4 ms). The gate is measured on the audio clock from the input event to the first changed sample.
5. **The dip is one stamped batch** (change 19): dip-down, the slot change and dip-up from one frame (now + lookahead), tagged as one sequence. If the batch arrives late, the core shifts the whole sequence by whole quanta so the change never applies above silence. The dip also silences the bus's reverb send, which today is taken before the gain stage (`bus.rs:540` against `:547-568`).
6. **A live addition that finds no core slot is deferred, not refused** (change 17). The core's `max_buses` is 32 on every preset, the same as the project limit, so this happens only while removed buses' slots wait to recycle (≈ 40 ms) or for a fifth effect; the edit is kept and applies when a slot frees, or at the next Play. "Buses past the first 32 show not metered" (change 22) can't occur.
7. **Any cycle among level rules is refused** (change 24), not only an ancestor trigger: A ducks B and B ducks A is a cycle no ancestor check sees. At most 8 level rules, 32 rules in all.
8. **The hook is `editor.project.onSectionChanged(key, listener)`** (change 18): `ProjectSurface.changed()` already exists with another meaning (`src/editor/sdk/project.ts:42-43`). It fires synchronously on an edit, an undo or a redo; Mixer previews (a drag in progress) bypass it. 0147 is Proposed, so its amendment is a section appended to it, written by task Hk1.
9. **`tainted` comes from monitor controls and Compare only** (changes 11, 20). MASTER ≠ 1, script and authored mutes and the hidden-tab mute **suspend the target check** instead of tainting the reading.
10. **The CPU figure is computed on main** from the cumulative counters (change 6); the wire's `loadPermille` stays 0, reserved. The clock fields are written by the shell, because the core has no clock.
11. **The worst-case loudness budget is master + 8,** not master + 7 (changes 12, 30): 0.08 ms for loudness and 0.10 ms for M5 in the worst scene, a tripwire move. The mixer wasm is 319,799 B today; M5 takes it to ≈ 347–351 KB against the 327,680 B gate (`native/audio/build.mjs:27`), also a tripwire move to raise and record in the build log.

### 2. Design rulings 0171 now reads with

From [rulings.md](../design/0171-audio-mix/rulings.md):
- **Rebuild replay:** a script fade or snapshot replays as its remaining ramp (a 5 s fade goes on); a dip replays as its end state.
- **Keyframes** are keyed on rendered STATUS frames, one a second, not on a block count, so idle cadence doesn't stretch them.
- **EPOCH** reasons are one per rebuild cause (start, trap, stall, device, rate, latency, mode) and carry `timeOffset`; a resumed context is a GAP, not an epoch.
- **One decoder** in a Worker serves files and the live recording.
- **Captures:** a 64 MiB decompressed cap; the built-in trigger keeps 16 files, deleting the oldest on Tauri and Android, and stops at 16 per session on the web.
- **The shared reverb runs out** until its input has been silent for its length, then resets, so removing the last send no longer cuts the tail.
- **STATUS** worst case 17,824 of 20,480 B.

### 3. Owner decisions (2026-11-13)

The owner took every recommendation except the floor run ("No to number 3, yes to everything else"):
1. **Reverb sends are post-fader:** a bus's send follows its fader, mutes, duck and snapshot, as FMOD's sends default. A muted or turned-down bus stops feeding the reverb. This changes today's sound for a bus with a send whose gain isn't 1 or that is muted; one named golden records it.
2. **Estimate:** 300.5 days of tasks (60.1 person-weeks) plus a **20% reserve** of 60 days in ten named items: **360.5 days, ≈ 72.1 person-weeks**, inside 0171's 62–75. No scope cut.
3. **No floor-conversion run.** Floor microseconds stay estimates at 0.6 ns per metered instruction; M5's metered gates are set in instructions, and the floor µs beside them are labelled estimates.
4. **The new first ladder step** pauses non-master metering before anything audible is shed, and is skipped when only master is metered; with buses metered, bed and zone shedding start 1 s later.
5. **The target check is suspended** while a monitor control or Compare is active; the target mark shows "paused".
6. **Capture files are labelled:** they carry the project's `audio` section, name and version and the clip, bus, event and parameter names; the Export option says so beside its checkbox.
7. **The built-in trigger is fixed:** F9 starts, then stops and saves (desktop and web); a one-second three-finger hold on touch; 16 files.
8. **A new level-ducking rule** starts with an RMS detector at −30 dBFS.

## Alternatives considered

- **One main-composed gate lane** for mutes, monitor controls and the dip (six lanes): a product of overlapping ramps isn't a ramp, so it's inexact, and it needs a composer on main. Seven lanes cost nothing at rest.
- **Stamped fader edits:** can't meet the 50 ms gate at 30 fps.
- **Pre-fader sends with only the dip and monitor controls scaling them:** changes no existing sound, but a muted bus keeps ringing the reverb, which designers don't expect. Not chosen by the owner.
- **A reserve of a third (80.1 pw):** above the range; the owner kept 20% as in M4.

## Consequences

- The task table in [api-and-models.md §11](../design/0171-audio-mix/api-and-models.md) is the plan's source: 79 tasks over M5-0, M5a, M5b, M5c, M5d.
- The samples that use `fadeTo` and buses with sends change behaviour (authored/runtime split, post-fader sends); task Sa1 and the listening pass cover them.
- Floor figures are estimates for the whole milestone; a real device run would replace them later.
- 0157's §4.7 (`loadPermille`), 0097's bus section and 0158's automation lane get amendment notes in task Dc1.

## Deprecates

- 0171's "refused visibly" for a live bus addition, "presence ordering fixes a one-quantum delay", the delta capture sizes, five gain factors, `editor.project.changed`, taint from MASTER ≠ 1 or mutes, and "master + 7".

## Open questions

- 0171's unverified list stands (real devices, worklet clocks on Firefox and WebKit, the game loudness targets, true peak against BS.1770 Annex 2, capture sizes on real scenes, the main-to-worklet latency of a live edit, the compressor's click cause, getting a file off Android). Reserve items RS1–RS10 hold their fixes.

## References

- [docs/design/0171-audio-mix/README.md](../design/0171-audio-mix/README.md): the design, its rounds and the coordinator's verification.
- [architecture.md](../design/0171-audio-mix/architecture.md), [api-and-models.md](../design/0171-audio-mix/api-and-models.md), [rulings.md](../design/0171-audio-mix/rulings.md).
- [spikes/audio-mix/README.md](../../spikes/audio-mix/README.md).
