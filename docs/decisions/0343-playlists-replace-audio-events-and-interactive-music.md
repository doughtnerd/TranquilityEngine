# 0343. Playlists replace audio events and interactive music

- **Status:** Accepted, amended by 0350 (blend regions and weight curves, fade shapes, Exit-marker tails, bridge fades, beat-quantised automation)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** 0158 (the `*.audioevent.json` container format and node types), 0166 and 0167 (the music node format); their runtime machinery is kept and re-homed as described here
- **Related:** 0157, 0224, 0229, 0248, 0263, 0269, 0285, 0293, 0299, 0304, 0306, 0320, 0341, 0342, 0344–0348

## Context

The engine has two authoring models in one file, `*.audioevent.json` (`myco.audioevent@1`):

- **Sound containers** (0158): `clip`, `random`, `sequence` (step or back to back, *not* a timeline), `switch`
  (labelled parameter, `onChange` keep/restart/crossfade), `blend` (one parameter, `range` and `fade` per child),
  `layer`, `sustain` (start/loop/end nodes); curves keyed on parameter values only.
- **Interactive music** (0166/0167): `segment` (tempo map, cues, entry/exit, regions with `while`, up to 16 equal-length
  stems with alternatives), music `playlist`, `musicSwitch`, transition rules (exit at beat/bar/cue, fades, bridges),
  stingers, a segment library.

The prototype's **Playlists** screen replaces both with one family the owner calls *playlists*: **Clip** (one sample),
**Queue** (Random, Shuffle or Round robin picks with avoid-last and weights), **Switch** (a discrete parameter picks an
entry; change rules From/To · When now/beat/bar/exit · How crossfade/cut/transition playlist), **Blend** (1D or 2D over
scalar parameters or voice time, crossfade or layer, equal power, follow with glide or hold, a voice envelope), **Layer**,
and **Sequence**: a timeline of audio and playlist tracks with clips, per-clip loop overrides, hold points, sync and
async clips, automation over time or parameters and effects at clip, track and sequence level. Entries are always
playlists; a sample added to a non-Clip playlist is wrapped in an embedded Clip playlist. A playlist used in two places
is a *linked* copy; an embedded one belongs to its parent. Music is expressed with samples that carry tempo, loops and
Exit markers (0342), Switch rules that wait for a beat, bar or Exit marker, and sync clips in sequences.

The owner decided (2026-11-22) that the prototype's model wins, existing data migrates one way, and engine features
the prototype doesn't show (stingers, stems, beds, Doppler, ambisonics, bus automation, sustain) get a home rather than
being dropped. The prototype is a spec with known gaps: Switch timing is not simulated (beats are a fixed 500 ms),
transition playlists don't play, glide, weight-zero behaviour and the voice envelope are spec text only, and the
Playlists and Sequencer screens disagree on effect catalogues, curve formats and parameter lists.

## Decision

We will replace `*.audioevent.json` with one asset kind, the **playlist** (`*.playlist.json`, `myco.playlist@1`), run
it with a playlist runtime that reuses the music scheduler, and migrate existing events and music once.

**The file.** One playlist per file; embedded playlists are inline objects with the same shape (minus `format`).

```jsonc
{
  "format": "myco.playlist@1",
  "type": "queue",                 // clip | queue | switch | blend | layer | sequence
  "output": null,                  // bus id (0344); null = inherited from the referencing playlist, else Master
  "playback": { "plays": "oneShot", "maxInstances": 4, "whenFull": "stealOldest", // stealQuietest | stealFarthest | refuse
                "cooldown": 0, "chance": 1, "delay": 0, "priority": 128 },
  "volume": 0, "pitch": 0, "volumeRandom": [0, 0], "pitchRandom": [0, 0],          // dB, semitones
  "effects": [],                   // once per playing instance, on its mixed output (0345)
  "spatial": null,                 // attenuation and spatial options (0347)
  "parameters": [],                // local parameters (one parameter list, 0304)
  "stingers": [],
  "entries": [
    { "playlist": "audio/footsteps/dirt_01.playlist.json", "weight": 1 },        // linked
    { "embedded": { "type": "clip", "entries": [{ "sample": "audio/dirt_02.wav" }] }, "volume": -2 },
    { "sample": "audio/dirt_03.wav", "trim": null, "loop": "inherit" }           // only in a clip
  ],
  "queue":  { "pick": "random", "avoidRepeat": 1, "continuous": null },          // pick: random | shuffle | roundRobin
  "switch": null, "blend": null, "sequence": null
}
```

- **Entry, per use:** `volume` (dB), `pitch` (st), `weight` (Queue random; 0 = never), `x`/`y` (Blend position, in the
  axis's units), `atZeroWeight` (`stop` | `continue`), `curves` (gain, pitch, pan, low-pass, high-pass over voice time
  or a parameter; 0346). Samples appear only in Clip playlists; the editor wraps them as the prototype does.
- **Queue:** `continuous: { gapMs }` plays entries back to back until stopped (the engine's continuous containers and
  music playlists); `null` picks one entry per trigger.
- **Switch:** `{ parameter, map: { label: entryIndex | null }, labelGain: { label: dB }, onChange, rules }` with
  `onChange` and each rule as `{ when: "now" | "beat" | "bar" | "exit" | "nextTrigger", how: "crossfade" | "cut" |
  "transition", length: { ms } | { beats }, transition: <entry> }` and rules adding `from`/`to` (label or `"*"`).
- **Blend:** `{ axes: [axis] | [axis, axis], fade: "crossfade" | "layer", curve: "linear" | "equalPower", follow: {
  glideMs } | "hold", envelope: { mode: "off" | "morph" | "zone", low: ADSR, high: ADSR } }`; an axis is a scalar
  parameter name or `{ voiceTime: seconds }`.
- **Sequence:** `{ length, tempo: { bpm, meter } | null, tracks, loops, markers }`. A track is `{ id, name, kind: "audio"
  | "playlist", color, volume, pan, output, mute, solo, enabled, effects, automation, clips }`; a clip is `{ id, sample |
  playlist, at, length, offset, gain, pitch, pan, reverse, sync, enabled, loops: { loopId: override }, hiddenMarkers,
  effects, automation }`. Sequence loops are `{ id, start, end, active, binding: { parameter, op: ">" | "<", value },
  exit, exitFadeMs, reentry }`. Automation is `{ target, input, curve, bypass }`, target `volume | pitch | pan | enabled
  | fx:<effectId>:<param>`, input `clipTime | sequenceTime | voiceTime | <parameter>`.
- **Stingers:** `{ trigger, playlist, at: "now" | "beat" | "bar" | "exit" | "hit", ifLate: "nextGrid" | "playNow" |
  "skip", dontRepeat }`; `hit` lands the stinger sample's Hit point (0342) on the boundary.
- **References** are project paths, rewritten on move by the playlist asset kind (0314). Cycles are refused on edit
  ("it would contain itself"). Limits are declared once in the parse (0306): entries ≤ 256, nesting ≤ 16, tracks ≤ 32,
  clips ≤ 512, keys per curve ≤ 64.

**Runtime semantics** (the prototype's logic, made complete):
- **Trigger gate**, in order: cooldown since the last accepted trigger, chance, then max instances (steal the oldest,
  quietest or farthest with a 40 ms fade, or refuse). Refusals have reasons in the profiler (0348).
- **Picks are made once per trigger** on the main thread with the World's seeded generator. Random: weighted, excluding
  the last `min(avoidRepeat, n−1)`; Shuffle: a deck reshuffled when empty; Round robin: next, wrapping.
- **Down the tree** gains add in dB, pitch adds in semitones, pan takes the deepest non-zero, low-pass takes the minimum,
  high-pass the maximum. An `output` override sends the entry's audio to that bus, so its parent's playlist effects
  don't apply to it.
- **Blend:** 1D crossfade is piecewise linear between neighbours (layer: cumulative ramps); equal power uses √weight;
  2D uses a Delaunay triangulation with barycentric weights and projects outside points onto the nearest hull edge.
  `follow` smooths the input over `glideMs`; `hold` samples it at trigger. At weight 0, `stop` restarts the entry when
  it returns and `continue` keeps its time silently.
- **Switch:** rules score exact = 2, `*` = 0 for each side; highest wins, first listed breaks ties; no match uses
  `onChange`. `beat`/`bar` use the **musical clock of the playing entry** (its sequence's tempo, else its sync sample's
  tempo); `exit` waits for the next Exit marker in a playing sample, else that sample's loop end. A playing entry with
  no tempo makes `beat`/`bar` act as `now`, and the Studio lints it. A `transition` plays as the engine's bridge: the
  old entry leaves at the boundary, the transition plays, the new entry enters at the transition's Exit marker or end,
  with `length` as the crossfade.
- **Sequence:** the playhead and its loops follow the prototype's state machine: an active hold point parks it, an
  active loop wraps it, an inactive loop is left by `jump`, `crossfade` or `finish`, and `reenter` jumps back in when the
  loop turns active again. Clip time maps to sample time as pickup, first pass, further passes of the first loop filling
  the clip, tail. **Sync clips** move the sequence playhead with their sample's loops and leave at the next Exit marker;
  where sync loops overlap, the higher track drives and the others follow (the Studio warns). **Async clips** run their
  own voice clock and are not cut when the playhead leaves them. `untilStopped` keeps the instance alive until the game
  stops it; **release** ends held loops by their exit settings, **stop** fades everything over 120 ms. A playlist clip
  resolves once when the playhead enters it.
- **Envelope (Blend):** ADSR per the prototype (morph between low and high, or per zone); release ramps linearly.

**Runtime structure.** `runtime/playlists/` replaces the container logic in `runtime/events/eventRuntime.ts`. The main
thread still owns intent and picks (0157): a trigger resolves the tree into ordinary voices, automation bindings and
groups. The music scheduler (`runtime/music/`: planner, grid, transitions, stingers, anchors, hot reload, sounding
voices) becomes the musical clock for sequences with a tempo and for Switch rules timed to beats, bars and Exit markers;
its addressing becomes playlist paths and ids. The core gains time parameters (0346), loop modes (0342) and instance
submixes (0345).

**Public API.** `Audio.play(pathOrSample, options)` plays a playlist or a sample and returns an `AudioPlaylistHandle`
(today's `AudioEventHandle` members: `setParameter`, `getParameter`, `release`, `stop`, `music` positions, plus
`onMarker(type, fn)` for Cue, Exit and Hit markers passing); `AudioEventHandle` stays one release as a deprecated alias.
`AudioSource.clip` takes a playlist or a sample. Components keep `onMusicBeat`/`onMusicBar` and gain `onAudioMarker`.

**Migration** (`src/engine/audio/migrate/audioEvent1.ts`, used by the Studio and the editor on opening a project with
old files, after one confirmation, and by `npm run audio:migrate <dir>`): each `*.audioevent.json` becomes a
`*.playlist.json` beside it and references are rewritten; the old file goes to `.myco/migrated/`. Mapping: `clip` →
Clip; `random` → Queue random; step `sequence` → Queue round robin; continuous `random`/`sequence` → Queue with
`continuous`; `switch` → Switch (`keep` → next trigger, `restart` → cut, `crossfade` → crossfade); `blend` → Blend 1D
(entries at their range midpoints, a lint where fades overlapped); `layer` → Layer; `sustain` → Sequence with a held
loop; event fields → `playback`, `spatial`, `output`; `segment` → Sequence with its tempo, stems as sync audio tracks
(alternatives as a Queue on a playlist track), cues as sequence markers, `entry`/`exit` as Exit markers, regions with
`while` as loops bound to the parameter; music `playlist` → continuous Queue; `musicSwitch` → Switch with each
transition rule mapped (exit `beat`/`bar`/`exitCue` → when, fades → length, bridge → transition); stingers kept; the
segment library → embedded playlists. Exports and the runtime refuse `myco.audioevent@1` with a message naming the
migration.

## Alternatives considered

- **Keep `*.audioevent.json` and rename only in the UI** — no migration, but the file keeps two models (containers and
  music) the Studio would have to translate forever, and the prototype's sequences and change rules don't fit either.
- **Separate files for sequences and music** — the prototype converts freely between types in one place; one kind
  keeps "change type" a field edit.
- **Embedded playlists as separate files** — every Clip wrapper would be a file; inline keeps ownership with the parent
  as the prototype intends, and "Make shared" extracts one.

## Consequences

**Positive**
- One authoring model for effects, ambience, dialogue and music; music is no longer a separate world.
- Linked playlists give reuse; the timeline gives designers DAW-style control.
- The music scheduler's tested timing work is kept.

**Negative / costs**
- The largest change in the plan: a new runtime over the old event runtime, a migration and its tests, and every
  guide page on events and music rewritten.
- Public API additions and a deprecation (`AudioEventHandle`).
- Some old music features map approximately (blend fades, multi-tempo segments): the migration lints what it changed.

## Deprecates

- `myco.audioevent@1`, `src/engine/audio/eventFormat.ts`, `musicFormat.ts` and the container half of
  `runtime/events/eventRuntime.ts`: removed after the migration ships. `musicRules.ts`, `musicGrid.ts`,
  `musicPosition.ts` and `runtime/music/*` are kept, re-keyed on playlists.
- The `audioEvent` asset kind, the Event editor and the music panels (0341).
- Guides `sound-events.md` and `interactive-music.md`, rewritten as Playlists and Music guides.

## Open questions

- The Sequence's tempo and its samples' tempos can disagree; v1 plays samples at their own tempo and lints the clash
  (time-stretching is out of scope).

## References

- Prototype Playlists and Sequence screens (`Playlists.dc.html`, `Sequencer.dc.html`), Journeys j3–j8.
- `src/engine/audio/eventFormat.ts`, `musicFormat.ts`, `musicRules.ts`; `src/plugins/audio/runtime/events/`, `music/`.
- Guides `docs/wiki/guide/sound-events.md`, `docs/wiki/guide/interactive-music.md`.
