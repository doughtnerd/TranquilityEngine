# 0334. Takes record what the game asked of audio and replay it; profiler captures stay telemetry

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0171, 0172 (amended: captures gain pick paths, loudness warnings and written MIXOP records), 0227, 0230, 0260, 0261, 0326, 0327, 0329, 0333

## Context

The engine records **captures** (`.mycap`, 0171/0172): a ring of the core's STATUS blocks, one-second keyframes and
19 kinds of main-thread events, saved from the editor's Profiler or from game builds (`Audio.capture`, F9 in exports
with `audioCapture: true`). A capture is telemetry: parameters appear only as change events, keyframes hold a hash of
instance parameters, positions aren't recorded, and it can't be replayed. Its docs call one recording span "a take".
A `MIXOP` record type is defined and decoded but nothing writes it.

The prototype has two Run screens. **Take**: a recorded run you scrub, with event instances (lifetimes and held spans),
game parameter lanes, a picture lane, the authored-versus-live value of each property at the playhead, and links that
open the playlist behind an instance ("fix it at the source"). **Profiler**: captures with load and CPU, effects cost per
level, bus gain with its lanes, loudness against a target, voices with their status (played, stolen, blocked by a
voice limit, missing file), messages, a version rule for edits made during play, and a "Why it played" chain from the
game trigger through every playlist decision to the sample and the bus.

The owner (2026-11-22): a **take** is recorded from the editor or a live game build, for the audio designer to review,
analyse, annotate and audition audio against, to hear how it really performs in game. The **profiler** shows the
audio engine's performance and finds problems in processing and execution; it can profile the editor, a game build,
and a take as it plays. v1 records to files and views files; the live connection comes later.

## Decision

We will add takes as a new recording of the game's requests to audio, replayed by the Studio's runtime against the
current project, and keep captures as the profiler's telemetry with three extensions.

**A take** (`*.mycotake`, binary, the capture file's framing: a plain header, a JSON META block, typed records, an index,
deflate) records **what the game asked**, not what audio did:

| Record | Content |
|---|---|
| `PLAY` | instance id, playlist or sample path, options, emitter id, parameters at start |
| `STOP` / `RELEASE` | instance id, fade |
| `PARAM` | global or instance parameter, value (every change) |
| `POSE` | listener and emitter positions and velocities, 30 Hz, changes only |
| `MIX` | script bus volume and fade calls, snapshot start and stop, master volume |
| `TRIGGER` | stinger triggers |
| `MARK` | game markers (`Audio.take.mark(text)`) |
| `FRAME` | optional picture: a small JPEG of the game view once a second |
| `KEYFRAME` | every second: live instances with start times and current parameters, for seeking |

META holds the project, the engine version, the hash of `audio.json` at start, the World's audio seed and the device.
Readers follow the capture rules (0171): hard caps, refuse rather than misread, no migration of old formats.

- **Recording:** the recorder sits at the playlist runtime's entry points above the backend seam (`Audio.play`,
  `setParameter`, handle methods, the audio frame's pose read), so it sees every request once. In the editor, the Play
  toolbar gains a **Record take** toggle; takes save to the project's `takes/` folder. In game builds, `game.json`
  `audioTake: true` enables a hotkey (F10) and `Audio.take.start()`, `stop()`, `mark()`, `save(name?)` (public API);
  saved takes go through platform storage and are copied into the project by the Studio's import.
- **Replay:** the Studio builds a headless World with the listener and emitters, seeds it with the recorded seed, and
  re-issues the requests at their times against the *current* project, so edits are heard in context. Parameters follow
  their recorded values, poses interpolate. Seeking starts the instances alive at the seek time at their offsets from
  the nearest keyframe. While replaying, edits apply to instances started afterwards (the engine's hot-reload rule);
  **Restart instances** restarts the ones already playing with the new version.
- **Annotations** live beside the take in `<take>.notes.json` (an asset document with history): markers and regions
  with text and colour. The recorded file never changes.
- **The Take screen** draws instances per playlist (lifetime, held spans), parameter lanes, the picture lane, a mixer
  strip and the inspector's authored-versus-live values from the replaying runtime; an instance opens its playlist in
  Playlists. The parameter histogram in the Curves window (0332) is computed from the open take.

**Captures** stay `.mycap` and the profiler's source, with three extensions:
- **Pick paths:** `eventStart` records carry the decision path of the instance (each level: playlist, type, the choice
  and why: switch label, blend weights, queue pick, sequence clip), so "Why it played" is read, not guessed.
- **Loudness warnings:** a record when a metered bus's target state changes (`high`, `low`, back to `ok`), shown as
  markers and messages, so a loudness problem is found like a voice-limit one.
- **`MIXOP` is written:** live mix edits during a recording are recorded from the op log, so a capture shows what was
  changed and when.
- Sources: the editor's Play (a **Record capture** toggle beside Record take), game builds (F9, as today), and the
  Studio's own runtime while it replays a take, so the profiler can analyse a take as it plays (the live ring through
  the existing `LiveHost`). A capture made during a take replay names the take in its META; the Profiler offers
  "Open in Take" and the Take screen "Profile this take".
- The capture docs stop calling a recording span "a take".

**The Profiler screen** is the prototype's layout on the existing reader, worker, track kit (0261) and table kit (0326):
picture (when the capture names a take), load and CPU against the voice cap, effects cost per level (0331), bus gain
with its lanes, loudness against the target, voices with status and "problems only", parameters; At cursor, Voice, Why
it played and Messages panels, with keys to step between markers.

## Alternatives considered

- **One recording for both screens** — the owner separated them: a take is a designer's review material replayed
  through current audio; a capture is a fixed record of engine behaviour. A take replay can be captured when both are
  wanted.
- **Make captures replayable** — captures record results (voices, buses), which change when the project changes;
  replaying them would replay old decisions, not test new audio.
- **Record audio output into takes** — large files, and the point is to hear the current project, not the old one.

## Consequences

**Positive**
- Designers review and tune audio against real gameplay without running the game; annotations keep review notes.
- The profiler explains decisions and flags loudness, and can profile a take as it plays.

**Negative / costs**
- A new file format, recorder, reader and replay driver; public API (`Audio.take`) and an export flag.
- Replay is faithful to what the game asked, not to game logic that reacts to audio (a script waiting for a sound's
  end is not re-run).
- Capture format changes (new record fields): old captures are refused, as today's rules say.

## Deprecates

- Nothing removed. The capture docs' use of "take".

## Open questions

- Whether game builds should be able to upload takes and captures to a running Studio once the live link exists.

## References

- Prototype Take (`Main.dc.html`) and Profiler (`Profiler.dc.html`) screens, Journey j10.
- `src/plugins/audio/runtime/capture/`, `src/plugins/audio/editor/mix/profilerSource.ts`, `liveFollow.ts`,
  `tracks/`, `profilerTablesModel.ts`; guides `audio-profiler.md`, `audio-mix-api.md`.
