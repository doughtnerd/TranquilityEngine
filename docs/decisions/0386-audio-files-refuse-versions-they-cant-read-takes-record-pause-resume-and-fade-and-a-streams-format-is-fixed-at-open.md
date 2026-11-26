# 0386. Audio files refuse versions they can't read, takes record pause, resume and fade, and a stream's format is fixed at open

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0171/0172's capture header, 0328, 0348, 0351 and audio 0157's stream rings)
- **Related:** 0157, 0171, 0172, 0328, 0348, 0351, 0362

## Context

A review of the audio plugin raised owner questions; the owner's answers are recorded here with what was built.

- **Q19.** A capture or take from a newer audio core minor was opened, then refused record by record as `badValue` or
  `badRecord` ("damaged"), although nothing was wrong with it except its age. Packages were the same: a newer
  `myco.audiopack@2` read as "the table of contents isn't myco.audiopack@1". The owner: a file is never called damaged
  when it is just newer. Read the file's format version, compare it with the versions this build reads, and refuse one
  it can't read (a newer major or minor, an older one no longer read) up front, with "incompatible version: file is x.y,
  this build reads a.b–c.d". The capture format had a major only (`format`, ADR 0348) and the take format's minor
  (`TAKE_FORMAT_MINOR`, ADR 0354/0355) was a constant written nowhere.
- **Q18.** A take recorded `stop`, `release` and `trigger` at the handles (ADR 0348) but not `pause()`, `resume()`
  (ADR 0362) or `fade()`, so a replay of a run that paused or faded music played something else. The owner: match what
  was actually played.
- **Q22.** A STREAM_OPEN restart (a newer epoch, or the OPEN a SEEK awaits) could change a ring's sample rate and channel
  count while a voice read it; the voice kept the rate ratio and panner it bound with, so it played at the wrong speed
  or mixed the wrong channels. The owner: the industry standard. FMOD (`FMOD::Sound`), Wwise (streamed media), Unity
  (`AudioClip` streaming) and Unreal (`USoundWave` streaming) all fix a stream's format when it is created; a different
  format is a new sound.
- **Leftover of B66.** A voice taken over by a PLAY while the STATUS block's `ended` list is full waited in a
  1,024-entry carry list (`VoiceArea::replaced`); past that it went unreported.
- **Q20, Q21** (behaviour only, no format): a presence duck lifting to a shallower rule's level used the attack time;
  an unknown parameter label was stored as -1.

## Decision

**Versions (Q19).** Every audio reader with a version checks it before reading anything else, and a version it can't
read is refused as one, naming the file's version and the ones this build reads:

- **Captures and takes** (`*.mycap`, `*.mycotake`): header bytes 84..86, reserved and 0 until now, carry the format's
  **minor** (`CAPTURE_FORMAT_MINOR`, which is the take format's minor: a minor only adds take request records); 86..88
  stay reserved. `readCaptureHeader` refuses, as `newerFormat` or `olderFormat`: a `format` other than this build's, a
  minor above its own, a core ABI major other than its own (or a newer minor under another wire hash: a newer minor
  under this very hash wrote the same records and reads), and a status envelope major other than its own or a newer
  envelope minor. The message reads `incompatible version: file is capture format 2.3, this build reads 2.0–2.2` (or
  `audio core ABI 7.0`, `status envelope 1.4`). `wireMismatch` is left for this build's very ABI under another hash.
  Files written before this record carry minor 0 and read as before.
- **Packages** (`.mycopak`): a newer `MYCOPAKn` magic or `myco.audiopack@n` is refused with the same words.
- Builds before this record read the minor as a non-zero reserved word and refuse the file as a bad header: they
  could not have known better. From this record on, a newer file is always refused as newer.

**Take records (Q18).** Three request records join the take format, minor 2:

| type | name | payload after `t` (f64) |
|---|---|---|
| 0x1e | PAUSE | `u32 instance` |
| 0x1f | RESUME | `u32 instance` |
| 0x20 | FADE | `u32 instance, f32 to (≥ 0), f32 seconds (≥ 0)` |

The playlist handle (`pause`, `resume`, `fade`), the one-shot handle (`fade`) and `AudioSource.pause`/`resume` call the
take's sink (`TakeRequestSink.pause/resume/fade`) as `stop` and `release` do; a non-finite `to` (which the handle ignores)
isn't recorded. Replay (`TakeReplay`) re-issues them through the handle (`ReplayHandle.pause/resume/fade`, optional), and
a seek or loop that starts an instance again starts it where its pauses left it (the play offset less the time it stood
paused), paused if it was, at the fade gain its last fade had reached with the rest of that fade. Audio keeps
0x10..0x3f for request records (0x10..0x20 in use); plugins keep 0x40..0x7e. Since the records sit in the skippable
range, an older reader would pass over them and replay something else: the minor bump makes this build's readers
refuse a take from a newer one.

**Stream format (Q22).** In the core (`native/audio`, `StreamStore::open`), a restart of an open stream whose sample rate
or channel count differs from its ring's is refused, as a class or pool change already was: stream event `ERROR` (3) and
`ERR_BAD_ARG`, the ring untouched. The TS stream manager fails such a voice with a message that says a stream keeps the
format it opened with and to play the sound again (playing it again opens a new stream, in the new format); a refusal at
the open still says no ring was free. The worker never changes a stream's format across restarts today (it re-seeks the
same decoder), so this is a guard on the core's contract.

**Taken-over voices (B66 leftover).** Each voice slot gains a 4-byte `replaced` cell (`VOICE_SLOT_BYTES` 192 → 200; the
default preset's voices region 768 KB → 800 KB). A taken-over voice that finds `ended` and the carry list full waits in
its slot's cell, or the first free cell of another slot; the report drains the carry, then the cells, as room allows.
Nothing is lost unless more than 1,024 plus the slot count wait at once. No allocation on the audio thread.

**Q20, Q21.** Main's presence duck eases at the release of the rules it leaves when the goal gets shallower (as the
core's per-rule followers and a sidechain compressor's release do), attack only when it deepens. `Mixer.setParameter`
ignores a label the parameter doesn't have, with one warning per parameter and label naming the known labels.

## Alternatives considered

- **Q19: bump the capture `format` to 3 for the new take records.** Old captures and takes (format 2) would then be
  refused as older; a minor keeps them readable.
- **Q19: the take's minor in META's `take` section.** META is read after inflating the payload, not up front, and a
  capture (not a take) has no take section.
- **Q19: refuse a newer core minor under this build's own wire hash too.** It wrote the same records, so the file reads
  correctly; refusing it would refuse readable files.
- **Q22: rebind the voice to the new format.** The owner chose the standard: a stream's format is fixed at creation.
- **B66: a larger fixed carry list.** Any fixed size can fill; cells per slot grow with `maxLogical`.

## Consequences

**Positive**
- A file from a newer build says so and what to do (update), never "damaged".
- A replay matches a run that paused, resumed or faded its sounds.
- A stream voice never plays at the wrong speed or with the wrong channels after a restart.
- A flood of takeovers is reported in full once room comes back.

**Negative / costs**
- Takes written by this build (minor 2) are refused by builds before it as a bad header.
- 8 bytes more per voice slot (32 KB at the default 4,096 slots).
- JSON asset formats (`myco.playlist@1`, `myco.dialogue@1`, `audio.json`, …) are still read leniently: a newer one is
  read as the current one with a problem line. Refusing them needs every editor and the runtime to handle a refused
  asset (read-only open, no save over it). The owner chose to keep them lenient for now (see Open questions).

## Deprecates

The reserved u32 at capture header offset 84 (now the minor and a reserved u16). The "no ring free" message for every
core stream refusal.

## Open questions

- Should the lenient JSON audio asset readers refuse a newer `@n` up front (and the editors open such an asset read-only)? **Owner, 2026-11-24: no, they stay lenient until that causes a real problem.**

## References

- Review findings Q18–Q22 and B66 (2026-11 audio review).
- `src/plugins/audio/runtime/capture/format.ts` (`readCaptureHeader`, `CAPTURE_FORMAT_MINOR`), `src/engine/audio/take/records.ts`,
  `src/studio/runtime/takeReplay.ts`, `native/audio/crates/audio-core/src/stream.rs`, `voices.rs`.
