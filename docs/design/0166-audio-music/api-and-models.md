# 0166 interactive music: API, data models, formats and plan (M4), revision 3 (owner decisions)

Senior engineer's design for ADR 0166 (Accepted, revision 2 plus the owner decisions). Companion to `architecture.md` (cited **[ARCH §n]**: timing, memory, failure behaviour, observability, platforms), to 0162's `api-and-models.md` (the shape this file follows) and to 0157's. This file owns the public API, settings and the event file format with its limits and ids, internal models, every byte layout, native and TypeScript layout, editor integration, the Babylon mapping, the test plan and the task table. What I need from the architect is numbered **S1-S14** in `contracts-senior.md` (statuses after round 2); the architect's needs from me are **C1-C18**, answered in §12. I do not restate timing, memory or failure rules: [ARCH §n] has them, and each section below points to it.

Units: seconds on the heard clock (`Audio.time`'s base) unless a field says otherwise; audio frames at the context rate; `performanceTime` is a `performance.now()` value in milliseconds (what `event.timeStamp` holds); linear gain; musical positions are bar, beat and tick (§2.2); little-endian; byte offsets are from the first byte of a record, head included. Line numbers cite the tree at 2026-11-11. Owner rules applied: follow Wwise and FMOD (inline), no feature flags and no migration (the samples change, §1.7), and no run that cannot change a decision (§9). "Display frame" and "audio frame" are always spelled out.

## 1. Public API

Everything is exported from `src/myco.ts` (§6). Nothing names Babylon, three.js, Rapier or Howler (ADR 0010).

### 1.1 Types

```ts
/** `"beat"`, `"bar"`, or every n-th: `{ every: "bar", n: 2 }` (n 2..64). Wwise's grid; FMOD's quantisation. */
export type GridSpec = "beat" | "bar" | { every: "beat" | "bar"; n: number };
/** The three callback kinds: `onMusicBeat`, `onMusicBar`, `onMusicCue` as component messages; `"beat" | "bar" | "cue"` for `handle.onMusic`. */
export type MusicKind = "beat" | "bar" | "cue";
/** The result of `handle.music.seek`: the planned heard landing time (seconds), or a refusal. A permanent refusal (invalid position or segment, not playing, never fits the pool) is final; a temporary one (no free rings) is retried each display frame until the target changes. */
export type MusicSeekResult = { ok: true; time: number } | { ok: false; reason: "invalid" | "notPlaying" | "neverFits" | "poolFull"; permanent: boolean };
/** A point on the music's grid, heard time in seconds. */
export interface GridPoint { time: number; bar: number; beat: number; segment: string }

/** What a beat, bar or cue callback carries. Every field states its unit. */
export interface MusicEvent {
  handle: AudioEventHandle;
  segment: string;            // node id of the playing segment
  bar: number; beat: number;  // 1-based integers; a bar event has beat 1
  cue?: string;               // onMusicCue only
  tempo: number;              // beats per minute at this point
  beatsPerBar: number;
  time: number;               // seconds: when this beat is heard, `Audio.time`'s base
  heardIn: number;            // seconds until it is heard: time - Audio.time; >= 0 unless `missed` > 0
  missed: number;             // beats of this kind coalesced into this call; 0 normally
  skippedCues?: string[];     // cue events only: the names of cues coalesced away
}

export interface MusicPositionAt {
  segment: string | null;     // null: the music is not playing at that instant
  bar: number; beat: number; beatFraction: number;   // 0..1 through the beat
  nearestBeatTime: number;    // seconds, the nearest beat's heard time
  offset: number;             // seconds, signed: positive means the input was late; raw, before calibration
  judged: number;             // offset - Audio.calibration (seconds): what a rhythm game compares
}
```

### 1.2 `AudioEventHandle` additions and `handle.music`

```ts
interface AudioEventHandle {            // backend.ts; ADR 0158 members unchanged
  /** The music state; undefined unless the event's root is a segment, playlist or musicSwitch. */
  readonly music: MusicHandle | undefined;
  /** Subscribe to beat, bar or cue events of this music instance, for scripts that `Audio.play` music with no node (M4c; owner decision 3). Returns an unsubscribe function. A non-music handle returns a no-op function. */
  onMusic(kind: MusicKind, fn: (e: MusicEvent) => void): () => void;
  /** Fire the stinger whose `trigger` is `name`. True when accepted; false when unknown, dropped by `dontRepeat` or `ifTooLate: "skip"`, or the pool refused it (the debug rows say which). */
  trigger(name: string): boolean;
}
interface MusicHandle {                 // readable from M4a; every getter is main-side state, no call to the core
  readonly segment: string | null;      // id of the playing segment; null while priming the first one
  readonly bar: number; readonly beat: number; readonly beatFraction: number;
  readonly tempo: number; readonly beatsPerBar: number; readonly beatUnit: number;
  readonly time: number;                // heard time of the position above: this display frame's `Audio.time`
  /** The pending change, or null: target child id and the heard time it lands. */
  readonly transition: { to: string; time: number } | null;
  /** Next grid point of that spec. For a pending change the points after `transition.time` are the new segment's (`GridPoint.segment` says which). null when not playing. */
  nextGrid(spec: GridSpec): GridPoint | null;
  /** Map an input timestamp to the music. Arrives in M4c; `segment` is null when the music is not playing at that instant. */
  positionAt(performanceTime: number): MusicPositionAt;
  /** Jump to a musical position (M4b; owner decision 4; behaviour is [ARCH §3.9], C20). `"bar:beat:tick"` (§2.2) is read in the segment that will be playing when the seek lands; seeking to another segment is not a seek (that is a switch or playlist change under the rules, as Wwise's `SeekOnEvent` and FMOD's `setTimelinePosition` seek within the playing segment; coordinator ruling R25). Clamped to [file start, segment end]: at or past the exit cue the segment plays on and the container advances as at a natural end; before the entry cue it is allowed and enters exactly there, with no extra pre-entry. A pending change is replaced before its cancel point (T - L); after it, the seek is planned after T, in the incoming segment. A seek into a `count` region restarts its pass count; into a `while` region the condition is read at the next commit point. The playlist cursor, the item's `plays` count, the switch value and the alternative picks are unchanged (seeking to another item is not a seek). The skipped span fires no `missed` or `skippedCues`. Stamped like every music change; in rhythm mode callbacks are held until it lands. Fallback: decoded stems restart at the offset, streamed stems seek their HTML5 element, best effort. */
  seek(to: string): MusicSeekResult;
}
```
`handle.music` is `undefined`, never an empty object, for non-music events. The getters share one snapshot per display frame, recomputed on first read (no allocation after it). `handle.onMusic(kind, fn)` delivers the same `MusicEvent` as the component messages, in the same `engine.AudioMusic` step before `engine.UpdateScripts`, with the same window and coalescing (`missed`, `skippedCues`; C15). Component messages fire first, then listeners in subscription order; a listener added during a dispatch first hears the next event; a throw in `fn` is caught and logged (`console.error`) and does not stop others; a subscription ends with its instance. An instance with no component hook and no listener is not predicted at all. `setParameter` already exists; for a `musicSwitch` the latest call before the quantised exit wins, and setting it back to the playing child cancels the change. `handle.stop(fadeSeconds)` stops all stems with one in-voice fade stamped at now plus the lookahead like every music record (R19: no music record is asap); it is not grid-quantised and is allowed in rhythm mode (it ends callbacks). `handle.fade`, `release` are as 0158. A music event is flat: its `spatial` key is ignored with a problem.

### 1.3 `Audio` additions

```ts
Audio.horizon: number;       // seconds, read-only: the earliest heard time a stamped start is exact for a DECODED clip (now + lookahead). Not a promise for a streamed clip: those need priming. Fallback backend: Audio.time.
Audio.timeAt(performanceTime: number): number;   // the RAW clock map: heard time of a performance.now() instant (event.timeStamp). Calibration is never applied here (R18). Audio.time before the clock has an estimate. Public without rhythm mode.
Audio.calibration: number;       // seconds, read/write, default 0: SUBTRACTED from an input's offset (judged = offset - calibration)
Audio.calibrationStale: boolean; // true after a device change until a new calibration is set; the value is kept
Audio.latency: { base: number; output: number; limiter: number; total: number; reliable: boolean };  // seconds, read-only; `reliable` is 0 < output < 0.5 and not exactly 0 (S13)
Audio.rhythmMode: boolean;   // read-only: the project setting
```
`Audio.play(music, { at })`: `at` is the heard time the entry cue is heard (the pre-entry starts early). Closer than the prime lead ([ARCH §4.1]): it starts at the earliest stampable frame, now plus the lead, with one warning (R12). There is no grid before the first segment, so that frame becomes the segment's start and anchors the grid; every later change lands on a grid point. `Audio.time` read in `update()` is now this display frame's value (the early step, §6); before it was last frame's.

### 1.4 Component messages (M4c)

`LifecycleHooks` (`Component.ts:139`) gains `onMusicBeat?(e: MusicEvent)`, `onMusicBar?(e)`, `onMusicCue?(e)`, with `MusicEvent` declared in `engine/audio/musicTypes.ts` (the engine core imports no plugin, as for `onTriggerEnter`). They go to the active `GameBehavior`s on the node of the `AudioSource` that plays the music (the dispatch style of `PhysicsCore.notify`: look up the hook, `try`, `console.error` on a throw). **Phase:** the built-in system `engine.AudioMusic`, phase `update`, `after: ["engine.Lobby","engine.PredictionSmooth"]`, `before: ["engine.UpdateScripts"]` (the slot of `engine.UIDocumentEvents`, `UIDocument.ts:998`). A node with no component that defines a hook costs nothing: the subscription mask is recomputed when the node's component list changes, and predictions run only for subscribed instances. After a gap longer than one beat each kind fires once with `missed: n`. A script that calls `Audio.play` itself has no node, so it subscribes with `handle.onMusic(kind, fn)` (§1.2) or polls `handle.music`. Coalesced cue events carry `skippedCues: string[]` (R20).

### 1.5 Calibration and rhythm mode (M4c)

```ts
export const Calibration: { fromTaps(offsets: readonly number[], options?: { warmup?: number }): CalibrationResult };
interface CalibrationResult { offset: number; spread: number; confidence: number; used: number; discarded: number; steady: boolean }
```
`offsets` are raw `MusicPositionAt.offset` values in seconds. The first `warmup` (default 4) are dropped; `offset` is the median of the rest and `spread` their MAD (a plain median is as good as any trimming on the spike's simulated taps, and a mean is unusable with misses). `confidence = clamp01(1 - spread / 0.040) x min(1, used / 16)`; `steady` is spread <= 40 ms and used >= 8. Persistence uses `Storage` (ADR 0024), namespace `settings`, key `audio.calibration.<sinkId or "default">`; on the context's device event `Audio.calibrationStale` becomes true and the value is kept. Rhythm mode (`audio.rhythmMode`) creates the context with `latencyHint: 0` and reads `baseLatency` and `outputLatency` back into `Audio.latency`; a change of the setting goes through the rebuild path. **It refuses nothing (R19):** every music change is stamped in both modes, so there is no asap music change to refuse; what rhythm mode adds is stamped recovery re-entry and holding callbacks during a recovery ([ARCH §4.6]). It promises no absolute latency.

### 1.6 Debug and counters (one task, P10)

`Audio.debug()` gains `music: MusicDebugRow[]` and `musicTotals` (fields per [ARCH §9], C11). A row: `id`, `asset`, `state` (`priming | playing | transitioning | recovering | ending`), `segment`, `pass`, `bar`, `beat`, `tick`, `tempo`, `beatsPerBar`, `time`, `pending` (`{ to, time: "bar:beat", rule: index, ruleKey: "from>to", tier: 1..4, parent: id of the container that supplied it, exit, enter }` or null), `groups` (`{ id, state, primed, of }[]`), `stems` (`{ name, primed, streamed, ring }[]`), `primeLastMs`, `primeEmaMs`, `leadMs`, `replans` (by reason), `refusals` (by cause), `lateGroups`, `groupsHeld`, `groupTimeouts`, `lastSlipFrames`, `recoveries` (by cause), `missedBeats`, `stingers` (`played | late | skipped | dropped`). Totals: `poolUsed`, `poolSize`, `poolHighWater`, `musicRingRefused`, `streamStartsLate`, `maxSlipFrames`, `splitQuanta`, `voiceSplits`, `curvePoolFull`. Every field states its unit. Each refusal, re-plan and slip also warns once per cause (`poolFull`, `neverFits`, `primeLate`, `groupLate`, `groupHeld`, `stemFailed`, `tailRefused`, `lengthMismatch`, `noGapless`, `leadOverBeat`); the panel's Music section is the live monitor.

### 1.7 Compatibility

| Member | Change |
|---|---|
| `Audio.time` in `update()` | this frame's value (was one frame old); no flag |
| `Audio.play(event, options)`, `playOneShot` `at` | unchanged; stamped starts as before |
| `AudioSource` | plays a music event like any event; `loop`, `spatial`, distances come from the event and are ignored for music |
| `handle.panner`, `occlusion` | the first playing stem's |
| `Audio.debug()` | gains `music`, `musicTotals`; existing rows unchanged |
| Every stamped per-voice record (`STOP`, `FADE`, `SET_PARAMS`, `SET_VOICE_FX`, `SET_PAUSED`, `SEEK`, `SET_LOOP`) | applies inside the voice (M4-0, R2); stamped goldens re-recorded, unstamped bit-identical; a stamped spatial play with sends no longer splits the quantum |
| Samples | sound-lab `music-intensity` becomes a segment with stems; flappy's `music.prefab.json` points at a streamed segment event; `project.json` presets gain `music.rings` |

## 2. Settings and asset data

### 2.1 `audio` keys

| Key | Type, range | Default | Parse rule (lenient, `problems[]`, as `settings.ts` does) |
|---|---|---|---|
| `music.rings` | integer 0..16 | low 8, default 12, high 16 | clamp plus problem. Sets `max_music_rings`; 0 refuses streamed stems with a warning (decoded stems still play) |
| `rhythmMode` | boolean | false | anything else: false plus problem |

Presets (`VOICE_PRESETS`, `audioSettingsModel.ts:235-237`) gain `musicRings` 8 / 12 / 16 and `voicesPreset()` compares it. Music voices count inside the preset's mixed cap (owner decision 3): no new voice key. Rings are 307,200 B each: 2.34 / 3.5 / 4.7 MB.

### 2.2 Musical positions

A position is the string `"bar:beat:tick"`: bar 1-based, beat 1-based within the bar's metre, tick 0..959 (`MUSIC_TICKS_PER_BEAT` = 960 per beat, the beat being the `beatUnit` note). `"1:1:0"` is the start of the grid; `"end"` means the end of the audio, valid for `cues[].at` and `regions[].to`; `"start"` the start of the file. Durations are numbers: `beats` (float) or `seconds`. **Seconds are stored in exactly two places:** `gridOffset` (where bar 1 beat 1 sits in the files) and `fade.seconds`. A tempo marker carries `at` (where it takes effect, on a beat), `bpm` (beats of `beatUnit` per minute), `beatsPerBar` (1..32) and `beatUnit` (1, 2, 4, 8, 16). A metre change must sit on beat 1 tick 0 (else it snaps to the next bar with a problem). Editing a tempo moves later markers in seconds but never a cue: cues and regions stay on their beat (owner decision 1). Derived: file time = `gridOffset` + musical time; frames = `round(seconds x contextRate)`, computed once per stamp from float64 (error under half a frame, deterministic, golden-tested in G1).

### 2.3 Music nodes, limits, ids

Music nodes extend `NodeBase`. Placement: a music node is the event's root or a child of a music container (`playlist`, `musicSwitch`); a music node under any other container, or a 0158 node under a music container, is dropped with a problem. `pitch`, `pitchRandom`, `delay`, `range`, `fade` on a music node are read and ignored (one problem each); **no pitch on music (owner decision 2, C13):** a pitch automation binding on a track is a validation **error** (an error-level problem at parse and in the lint; the binding is dropped), and `pitch` on `AudioSource` and `EventOptions` is ignored for a music instance with one warning (the grid and loop prediction assume rate 1). **`id`** is required on every music node: `^[A-Za-z0-9_-]{1,48}$`, unique per event (checked like `parseParameters`), also on `library` segments. `NodeBase` gains optional `id` for every type.

```jsonc
{ "format": "myco.audioevent@1", "bus": "Music", "priority": 200,
  "root": { "type": "musicSwitch", "id": "world", "parameter": "State", "default": "explore",
    "children": [
      { "type": "segment", "id": "explore", "value": "explore", "gridOffset": 0.5,
        "tempo": [ { "at": "1:1:0", "bpm": 120, "beatsPerBar": 4, "beatUnit": 4 }, { "at": "9:1:0", "bpm": 90, "beatsPerBar": 3, "beatUnit": 4 } ],
        "cues": [ { "name": "entry", "at": "1:1:0" }, { "name": "hit", "at": "3:3:0" }, { "name": "exit", "at": "end" } ],
        "entry": "entry", "exit": "exit",
        "regions": [ { "id": "loop", "from": "1:1:0", "to": "9:1:0", "count": 0, "tailBeats": 4, "while": { "parameter": "Boss", "is": "alive" } } ],
        "tracks": [ { "name": "drums", "clip": "music/e-drums.ogg", "alternatives": ["music/e-drums-b.ogg"], "pick": "sequence",
                      "volume": 1, "bus": "Drums", "automation": [ { "parameter": "Intensity", "target": "volume", "curve": [[0,0],[1,1]], "quantize": "bar" } ] } ] },
      { "type": "segment", "id": "combat", "value": "combat", "tracks": [ /* ... */ ] } ],
    "transitions": [ { "from": "explore", "to": "combat", "exit": "exitCue", "enter": "entryCue",
                       "fadeOut": { "beats": 1, "curve": "equalPower" }, "fadeIn": { "beats": 1, "curve": "equalPower" },
                       "bridge": { "segment": "riser" } } ],
    "stingers": [ { "trigger": "secret", "segment": "hit", "at": "beat", "dontRepeat": 2, "ifTooLate": "nextGrid" } ],
    "library": [ { "type": "segment", "id": "riser", "tracks": [ /* ... */ ] }, { "type": "segment", "id": "hit", "tracks": [ /* ... */ ] } ] } }
```

**`segment`:** `gridOffset` (seconds >= 0, default 0: the pickup before bar 1, i.e. the pre-entry when the entry is `1:1:0`), `tempo` (1..64 markers, first at `1:1:0`, default one marker of 120 bpm 4/4), `cues` (<= 64, unique names; `entry` and `exit` name the entry and exit cue, defaults the cues of those names, else the grid start and the end), `regions` (<= 16: `id`, `from`, `to` positions, `count` 0 = forever or 1..64, optional `while`, optional `tailBeats` 0..16), `tracks` (1..16, the stems). **Track:** `name`, `clip`, `alternatives` (<= 8 clips of equal length; `pick` `random | sequence`, default `sequence`, one pick per pass), `volume`, `bus` (a bus name, default the event's), `automation` (the 0158 `Automation` with an optional `quantize: "beat" | "bar"`, targets `volume` and `lowpass`; a quantised binding is evaluated on main at the grid point and applied as a stamped 20 ms in-voice ramp, so the stem does not follow the parameter between grid points; a `lowpass` ramp is a class S record, a voice-local split, not a whole-quantum one). `while` is `{ parameter, is }` for a labelled parameter, or `{ parameter, atLeast }` or `{ parameter, below }` for a numeric one (the event format has no condition vocabulary today; this is the minimum, §11 point 7). **`playlist`:** `children` (segments or containers, <= 256), `mode` `sequence | random | shuffle` (random: weighted by `weight`, `avoidRepeat`; shuffle: a bag, each once per round), `rounds` (whole-list repeats, 0 = forever, default 1), per child `plays` (1..64, default 1). **`musicSwitch`:** `parameter` (labelled, local or global), `default`, children keyed by `value`; unlike `switch` there is no `onChange`: the rules decide. The whole event keeps `MAX_EVENT_NODES` 1,024 and `MAX_EVENT_DEPTH` 16; `library` segments count as nodes. Tempo markers <= 64, cues <= 64, regions <= 16, stems <= 16, alternatives <= 8, rules <= 256, stingers <= 32, `library` <= 64.

### 2.4 Transitions

`transitions` sits on a container: <= 256 rules, in list order.

| Field | Values | Default |
|---|---|---|
| `from`, `to` | the id of a **direct child** of the container, or `"*"` | `"*"` |
| `exit` | `GridSpec`, `"immediate"`, `"nextCue"`, `"exitCue"` | `"bar"` |
| `enter` | `"entryCue"`, `"sameTime"`, `{ "cue": name }` | `"entryCue"` |
| `fadeOut`, `fadeIn` | `{ beats \| seconds, offset?, curve? }`; `offset` (same unit, may be negative) moves the fade's start from the exit point; `curve` `linear`, `sCurve` or `equalPower` | 1 beat, `equalPower` |
| `bridge` | `{ segment: <library id>, fadeOut?, fadeIn? }` | none |

**Precedence:** tier 1 pair (`from` and `to` both named), tier 2 `from` named, tier 3 `to` named, tier 4 `*`->`*`; the first listed wins inside a tier, and the parse warns on a duplicate (same `from` and `to`) and on a rule shadowed by an earlier one. An always-present default rule is tier 4 with the defaults above. A change between segments under different children of a container, however deep, is matched in the **nearest common parent's** table: `from` and `to` name the children of that table whose subtree holds the source and the target. `exit` is clamped to the exit cue when it would fall after it (what follows the exit cue is the tail, §11 point 5). `enter: "entryCue"` starts the incoming group at its pre-entry (entry cue minus the audio before it); `sameTime` and `{cue}` start exactly there, with no pre-entry. A **natural advance** (a playlist item finishing its `plays`) always leaves at the exit cue; the matched rule supplies `enter`, fades and bridge, and its `exit` is ignored. Audio after the exit cue rings on under the next segment until it ends, on its own voices, ramp-free. Dangling `from`, `to`, `bridge.segment` and stinger `segment` ids are problems; the rule is dropped.

### 2.5 Stingers and library

`stingers` on a container: <= 32 of `{ trigger, segment (a library id), at, dontRepeat, ifTooLate, volume?, bus? }`; `at` is a `GridSpec`, `"immediate"` or `{ "cue": name }` (the next occurrence in the playing segment); `dontRepeat` seconds (default 0); `ifTooLate` `nextGrid | playNow | skip` (default `nextGrid`, with a warning when it fires). Stinger segments should be decoded clips; a streamed stinger takes a ring for its length. `trigger` names are one namespace per event; with several matches the deepest container above the playing segment wins, then list order. A stinger plays on its own voices over the music and never changes the grid; **at most 4 stingers sound at once per instance** (the fifth steals the oldest with a 5 ms fade, R20; a format limit). `library` (<= 64 segments) holds bridge and stinger segments, which are not playlist or switch children.

### 2.6 Validation in two tiers

**Parse** (`parseAudioEvent`, pure, never throws, as today): shapes, clamps, limits, ids, dangling references, duplicates, placement. **Clip facts** (`validateMusic(asset, facts)`, pure over an injected `facts(path)` returning `{ frames, rate, channels, gapless }` from the decoder's `Info`): run at the first play (warn once) and live in the editor. `gapless` is `Info.frames !== null`; the decoder already trims encoder delay and padding for MP3 with a Xing, Info or LAME header, Vorbis and AAC (`loop_seam.rs`), so the check is that the length is stated. Lint rows: stems of a segment differ in length (beyond 1,024 frames: the segment refuses to play; within: the shortest wins, warn), rate or channel count; an MP3 stem without a length header (`noGapless`); a streamed FLAC or WAV stem on `low` (warn: ~190 MiB of encoded data for 8 stems); a **peak ring need** over the preset's pool: the lint walks each possible sequence (a segment alone, A to B, A to bridge to B, a loop tail, an alternative hand-over) and counts the streamed stems sounding or primed at its peak, so decoded bridges (any bridge up to about 30 s) and decoded stems cost nothing; a need above the pool is a **never-fits** warning "needs N rings; this preset has M" and the planner refuses it at once without retrying (R14, R15); a decoded stem over 30 s; a silent stem; a tail longer than its loop; `alternatives` of unequal length; a cue past the audio. The editor shows the same rows (§7).

### 2.7 Import hints

When a clip is added to a segment the editor reads a WAV's `acid` (tempo, beats, metre), `cue ` plus `LIST/adtl` labels and `smpl` loops, and Ogg `BPM` and `LOOPSTART` comments (a small RIFF reader in TypeScript beside `loop_points.rs`'s `smpl` and Ogg path). They are suggestions written into the event once; the event file is authoritative. "Tempo from length and bar count" and tap tempo are editor functions (§7).

## 3. Internal models

Writers: **main**, **sys** (the per-frame audio system), **status** (the mirror), **core** (the worklet).

### 3.1 Core tables

Behaviour is [ARCH §4.3, §4.4]; layouts and sizes are here.

| Table | Home | Contents | Size |
|---|---|---|---|
| Music rings | `Streams` region, indices `G..G+M` after the `G = max_mixed/16` general rings (4..16) | 307,200 B each (`RING_BYTES`); a `music` STREAM_OPEN takes only these, others never do | M = 8 / 12 / 16: 2.34 / 3.5 / 4.7 MB |
| Due list | new region `Due`, before `Arena` | 256 due records plus 128 parked records of 48 B (`PendingRecord`); `pop_due` fills it each quantum | 18,432 B |
| Curve pool | new region `Curves` | 255 entries of 32 B: law, stop-at-end, `u`, `du`, from, to, frames left | 8,160 B |
| Group table | new region `Groups` | 16 entries of 160 B: id, size, present, state, flags, stamp frame, start frame, slip, held-since, up to 32 member voice ids. An entry is freed at the group's start (on time) or after its late, held or abandoned report | 2,560 B |
| Voice slot | unchanged, 192 B | by my count of its fields (`voices.rs:124-166`: 4 ramps of 16 B, an 80 B panner; the assert at `:167` is `<=`). `flags2` bit 1 `due`, bit 2 `gated`, bits 3-6 group index (0..15); `reserved: u8` is the curve-pool link (entry + 1) (R4) | 0 |

The core regions are 18,432 + 8,160 + 2,560 = **29,152 B on every preset**. A voice with no flag and no link renders exactly as today, so unstamped work stays bit-identical.

**Class G and class S** (R2). `pop_due` still pops every record due in the quantum, now into the due list; each marks its voice's `due` bit and the quantum renders once. **Class G**: FADE, SET_PARAMS with a gain-only mask, STOP (with or without a fade); applied by a start-sample compare inside the voice's gain loop. **Class S**: every other per-voice record, namely SET_PARAMS with pitch, low-pass, direction, score or bus bits, SET_VOICE_FX, SET_PAUSED, SEEK, SET_LOOP; applied by a split of **that voice's** render at the record's sample. Two class G records for one voice at different offsets in a quantum fall back to a voice-local split. Records that are not per voice (BUS_MIX, MASTER, LISTENER, configuration tables) keep splitting the quantum and count in `splitQuanta`; so does a quantum with more than 256 due records. A voice-local split counts in `voiceSplits`. A due record for a voice held by the gate is **parked** (up to 128, [ARCH §5.3]) and applied relative to the group's start when it starts, rebased by the slip (R10); a record past the 128th applies at its own frame, not rebased, and counts in `parkedOverflow`. A due record at a voice's own start frame applies before its first sample.

**Fade laws** (R5, R6): `linear`; `sCurve` is `p*p*(3-2p)`; `equalPowerIn` rises as `sin(p*pi/2)` and `equalPowerOut` falls as `cos(p*pi/2)`, from a 1,024-point table with linear interpolation (error 3.6e-7, spike S4's table); power-complementary for a crossfade. They run at **control rate**: the voice's linear `Ramp` retargets at each quantum boundary (and at the record's sample) to the law's value ([ARCH §4.4]). Never `libm` `sinf` or `sqrtf` per sample (spike S4: 4.5x slower in wasm). A running shaped fade lives in the voice's curve-pool entry; with the pool full the fade degrades to linear and `curvePoolFull` counts. Phase `u0` starts the ramp at `law(u0)` and runs the remaining `1 - u0` over the record's frames: REPLAY re-sends a fade under way with its current phase.

### 3.2 Main tables

| Table | Fields | Writer |
|---|---|---|
| Voice table additions (`voiceTable.ts`) | `musicGroup u16`, `stamped[<=4]` (frame, kind, args: the un-fired stamped ops, for REPLAY) | main |
| `MusicPlayer` (per music instance) | state, `root` runtime node, current `SegmentRun`, next `PlannedStart`, `GridAnchor`, pending `Transition`, playlist cursors and shuffle bags, stinger queue and `dontRepeat` stamps, `subscribed` mask | main, sys |
| `SegmentRun` | node id, anchor, `StemRun[]` (track, picked alternative, clip, voice, streamed, ring primed), loops done, region state, group id | main |
| `GridAnchor` | integer ticks from the segment's bar 1 beat 1 **plus** the heard time it is at, never raw audio frames: a context rebuild at a new rate recomputes frames through `ClockMap` | main |
| `PrimeJob` and estimator | group id, stream ids, requested time, primed set from STATUS, `primeEmaMs` (page-wide) | main, status |
| `RuleIndex` (per container, cached per asset) | pair-to-winning-rule table built lazily, tier recorded | main |

The group id comes from a counter over 1..1023 that skips live ids. A group is one display frame's batch; `commandWriter` keeps a group's records in one BATCH (a group never straddles two).

## 4. Binary formats

One schema (`audio-wire/src/schema/*.rs`, a new `music.rs` added to `SCHEMA_SOURCES`), generated into Rust and TypeScript by `gen_wire` (`npm run build:audio`); the schema hash covers the new file. Record head 12 B as 0157.

### 4.1 PLAY: the gate and `fadeZero`

The `reserved` u16 at offset 22 becomes `gate`: bits 0-9 `groupId` (1..1023; 0 = ungated), bits 10-15 `groupSize - 1` (1..64 on the wire; the core's table holds 32, a larger size is refused and counted) (R8). Decoded single voices such as stingers are ungated. All members arrive in one BATCH with the same `frameOffset`. PLAY `flags` gains bit 8 **`fadeZero`**: the voice starts with its `fade` ramp at 0, so an incoming stem is silent without touching `gain` (R5), and a stamped FADE to 1 opens it (`gain` stays free for stem automation). PLAY stays 56 B, and a stamped PLAY already starts at its sample inside its voice (it writes its slot at once and never enters the pending queue, `scheduler.rs:38`, `:57`; the voice starts at its offset in `render_range`, `voices.rs:380-394`; settled).

### 4.2 The `shape` word on FADE, SET_PARAMS and STOP

One appended word, `shape` (u32), on the three records that ramp a voice's gain: bits 0-2 `law` (0 linear, 1 sCurve, 2 equalPowerIn, 3 equalPowerOut), bits 16-31 `startPhase` (u0 = value / 65,536; resolution better than 1/65,536 as C5 asks). FADE becomes **28 B**, SET_PARAMS **60 B**, STOP **24 B**; an older record's missing word reads as 0 (linear, phase 0, today's behaviour; the envelope is **1.2**, appended words are minor). A fade-in is a PLAY with `fadeZero` and a stamped FADE to 1 with `equalPowerIn`; the outgoing stems get a FADE to 0 with `stopAtEnd` and `equalPowerOut`, same frame. There is no `from` field (dropped, R5). SET_PARAMS gain ramps may carry a law too (stem automation, a quantised ramp).

### 4.3 STREAM_OPEN

`flags` gains bit 1 `music`: the ring comes from the music pool; none free is refused, never falls back to a general ring, and is reported as stream event **4** (`musicFull`) (R7). Body size unchanged (40 B).

### 4.4 STATUS growth

Header 144 to **176 B** (`HEADER_BYTES`; sections move up 32 B). The layout lands once, in M4-0's wire task; the M4a fields read 0 until M4a.

| Off | Type | Field |
|---|---|---|
| 144 | u16 | `musicRingCount` (the `musicRings` section's count, <= 16) |
| 146 | u16 | `groupStartCount` (<= 8) |
| 148 | u16 | `musicRingsOpen` |
| 150 | u16 | `streamStartsLate` (voices that started after their stamp because a ring was not ready; cumulative, saturating) |
| 152 | u16 | `groupsLate` (cumulative, saturating) |
| 154 | u16 | `groupsHeld` (groups held by a starving member, cumulative) |
| 156 | u16 | `groupsAbandoned` (give-ups, cumulative) |
| 158 | u16 | `curvePoolFull` (cumulative) |
| 160 | u32 | `maxSlipFrames` (largest slip since init) |
| 164 | u32 | `splitQuanta` (whole-quantum splits, cumulative; R3) |
| 168 | u32 | `voiceSplits` (voice-local splits, cumulative; R3) |
| 172 | u32 | reserved |

New sections after `zoneEvents`: `musicRings {u32 streamId; u32 epochFlags}[musicRingCount]` (8 B, **every open music ring**, a level reported each STATUS so a lost report repairs itself; `epochFlags` bits 0-29 the ring's current epoch, bit 30 **primed** (>= `START_FRAMES` 4,096 frames in the current epoch, or input ended), bit 31 **bound**); main accepts a primed bit only for the epoch it last sent (R7). `groupStarts {u16 groupId; u16 flags; u32 slipFrames; u32 startFrameLo; u32 startFrameHi}[groupStartCount]`: one item **per group**, 16 B (flags: bit0 late, bit1 held and resumed, bit2 abandoned), <= 8 per STATUS, the rest carry over like `starved`. Stream event 4 as §4.3. Worst case: 15,904 - 144 + 176 + 128 + 128 = **16,192 B** of 16,384, **192 B spare**. The next growth raises the shell's `STATUS_BUFFER_BYTES`. The primed bit is ring state seen by the worklet, not a worker message (revision 2, item 2); the deadline is [ARCH §4.1].

### 4.5 Init, ABI, constants

`myco_audio_init(sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zone_slots, zone_max_frames, max_wide, max_music_rings) -> i32`: a signature change, so **ABI 3.0 (0x300)** as 0162's R6 did for 2.0 (every caller is in the repo); `max_music_rings` 0..16 is validated (`InitError::MusicRings`) and sizes the `Streams` region to `(G + M) x RING_BYTES`; `Due`, `Curves` and `Groups` are always laid out. Decoder ABI stays 0x102. `gen_wire` emits `MAX_MUSIC_RINGS` 16, `MAX_GROUPS` 16, `MAX_GROUP_MEMBERS` 32, `CURVE_ENTRIES` 255, `DUE_RECORDS` 256, `PARKED_RECORDS` 128, `PLAY_GATE_ID_MASK`, `PLAY_GATE_SIZE_SHIFT`, `PLAY_FLAGS_FADE_ZERO`, `STREAM_OPEN_FLAG_MUSIC`, the law values and the shape-word masks, `STREAM_EVENT_MUSIC_FULL` 4, `FADE_CURVE_TABLE_POINTS` 1,024, `HEADER_BYTES` 176 and the packers and readers. `vectors/wire.json` gains golden records for each longer record, a gated PLAY with `fadeZero`, and a STATUS with both sections; the fuzz adds a truncated shape word, a gate of size 64 and id 1023, a STATUS with 8 `groupStarts`. The architect quotes constants by name (S11).

### 4.6 Worker protocol and the backend seam (C8, C10)

`primeGroup` (main to worker, `decoder/protocol.ts`): `{ group, retarget, members: [{ streamId, epoch, asset, bytes?, startFrame, region?, loop, music: true, convention }] }`. The worker keeps each music instance's encoded bytes, **refcounted by path for the instance's lifetime** (R16), so `bytes` is sent only on a miss; the cache evicts files of segments neither playing, primed nor a candidate successor, within a per-preset encoded budget (48 / 96 / 160 MiB, est., the §2.6 lint's number). It posts every member's STREAM_OPEN and first chunk before any second chunk, then tops up round-robin. `retarget` with new epochs restarts members already open, in the same order. `groupOpened { group, members: [{ streamId, openMs, error? }] }` (worker to main) is **diagnostics only**, never the primed signal. The backend gains a `MusicBackendCaps` record (`primes`, `stampedFades`, `heardClock`, `rhythm`) and the operations admit and prime a group, read primed state, stamp a group's records, cancel a group, and receive group-start, starve, end and error events; the player branches on the record, not the backend type (the core: all true; the fallback: `stampedFades` only for decoded clips, no priming, `currentTime`, no rhythm).

## 5. Native layout

| Where | New | Changed |
|---|---|---|
| `audio-wire/src/schema/` | `music.rs` (gate, `fadeZero`, shape word, flags, STATUS fields and sections, constants) | `batch.rs`, `envelope.rs`, `status.rs`, `schema.rs` |
| `audio-core/src/` | `due.rs` (due list, classes, parked records, voice-local split), `curves.rs` (pool, laws, control-rate retarget), `groups.rs` (table, gate, hold on starve, rebase, give-up) | `scheduler.rs` (`pop_due` into the due list), `voices.rs` (due flags, gain-loop compare, class S split, gate in the SCHEDULED branch), `stream.rs` (pools, `musicRings`, `music` flag), `params.rs`, `layout.rs` (`Due`, `Curves`, `Groups` before `Arena`), `status.rs`, `counters.rs`, `core.rs` |
| `audio-dsp/src/` | an `equal_power` table next to `ramp.rs`: a checked-in 1,024-point constant generated by a tool and verified by a test (no `sin` in a const context) | `ramp.rs` (retarget helper) |
| `audio-wasm` | init signature | exports |

**Size:** mixer 265,952 B after M3 against the 320 KB tripwire (build log D25), warning at 300 KB. Estimate +14 KB (due list and classes +6, curves +3, groups and hold +4, pools +1; before `wasm-opt`) to about 280 KB; the senior RFC's +8 KB target is not met. Recorded in the build log as a tripwire move, like the allowances of [ARCH §7.2] (R23). The metered gate gains the Z5 and Bench1 scenes at 10%.

## 6. TypeScript layout

```
src/engine/audio/        musicFormat.ts musicPosition.ts musicGrid.ts musicRules.ts musicValidate.ts musicTypes.ts (new)
                         eventFormat.ts (NODE_TYPES, id, eventNodes, eventClips, writer)   settings.ts (+music.rings, rhythmMode)
src/plugins/audio/runtime/
  music/ segmentRun.ts planner.ts anchors.ts playlist.ts stems.ts musicSwitch.ts transitionRules.ts transition.ts
         loopTail.ts regions.ts stingers.ts beatClock.ts musicSystem.ts handle.ts calibration.ts reload.ts background.ts   (new)
  core/  commandWriter.ts voiceTable.ts replay.ts statusReader.ts debug.ts clock.ts context.ts initParams.ts coreBackend.ts (changed)
  decoder/ streams.ts protocol.ts   events/eventRuntime.ts   Audio.ts AudioSource.ts audioSystem.ts backend.ts babylonBackend.ts
src/myco.ts   + GridSpec, GridPoint, MusicEvent, MusicPositionAt, MusicHandle, Calibration
```
**Frame order** (header of `audioSystem.ts` gains step 0): `engine.AudioMusic` (R17; update phase, `after: ["engine.Lobby", "engine.PredictionSmooth"]`, `before: ["engine.UpdateScripts"]`, acting only in the World that has the view) calls `backend.beginFrame()` (idempotent per frame: `ClockMap.beginFrame` does nothing the second time at the same `rafTime`), reads the status mirror, dispatches beat messages. `engine.Audio` (lateUpdate) runs 1-8 as in M3, then a new **9. music plan** (`planner`, commits groups, stingers and quantised ramps into the batch) before `frameCommit`. Plugin boundary (`plugins.test.ts`): the audio plugin imports nothing from other plugins; `musicTypes.ts` lives in the engine so `Component.ts` can name `MusicEvent`.

## 7. Editor integration

Through `src/editor/sdk` only; no new contribution point (the segment view is a panel like the event editor's).

| Change | How | Files (`plugins/audio/editor/`) |
|---|---|---|
| **Segment view**: stem lanes with waveforms, bar and beat ruler from the tempo map, tempo and metre lane, zoom and scroll, playhead, draggable cues, regions and tempo markers with snapping and undo | a panel opened from a segment node | `music/SegmentView.tsx`, `segmentViewModel.ts`, `segmentDrag.ts`, `peaks.ts` |
| Segment panel: tempo from length and bars, tap tempo, stem list (solo, mute, gain, alternatives), cue and region forms | beside the view | `music/SegmentPanel.tsx` |
| Transport and audition through the real backend: from any cue or bar, loop with its tail, trigger a parameter or stinger while playing, hot reload | the existing `Audition` machinery | `music/transport.ts`, `event/auditionHost.ts` |
| **Rules table**: from by to grid with wildcards, the effective rule highlighted with a "why" readout (tier and rule index), lint for shadowed, unreachable and duplicate rules, a rule editor, "audition this transition" from a chosen position | a panel on a container | `music/RulesTable.tsx`, `RuleEditor.tsx`, `rulesModel.ts` |
| Event tree and `NodeProperties` gain the three nodes, ids, the stinger list with a trigger button, `library` | node fields | `event/nodeFields.ts`, `NodeProperties.tsx`, `EventTree.tsx` |
| Import: drop files onto a new segment (stems, hints, lint rows of §2.6) | asset drop | `music/import.ts` |
| Project Settings > Audio: `music.rings`, `rhythmMode`, preset comparison | `AudioSettingsSection.tsx`, `audioSettingsModel.ts` | |
| Debug panel Music section (the live monitor) | `AudioDebugPanel.tsx`, `audioDebugRows.ts` | |

Waveform peaks are computed in the decoder worker into mip levels and cached per asset and mtime; the view draws only the visible span. All colours use the theme tokens (CLAUDE.md).

## 8. Babylon fallback

Best effort (owner). Checked against `babylonBackend.ts` (1,055 lines).

| Feature | On the fallback |
|---|---|
| Segments with decoded stems | stamped starts through `StaticSound.play({ waitTime })` (`:286`), fades through `setVolume` ramps; main plans from `Audio.time` without the latency correction |
| Streamed stems | HTML5 `StreamingSound`, flat, no alignment, one warning per segment (`warnFlatStream`) |
| Playlists, switches, rules, stingers (decoded) | main-side logic is the same; switches land on bar boundaries |
| Group gate, priming, ring pool, in-voice ops | none: `primed` is always true, one warning that stems may drift |
| Beat callbacks | from the same main-side clock, uncorrected for output latency |
| Rhythm mode, `Calibration` persistence | rhythm mode unavailable (warning); `Calibration.fromTaps` still works |

## 9. Test plan

Cadence (owner rule): **per task** typecheck, the affected unit tests (`vitest related` or the file's tests), `cargo test -p <crate>`. **Wave end:** full `npm test`, `npm run build`, Chromium e2e, `check:audio-metered`, short benches. **Milestone end:** `@slow` e2e, WebKit and Firefox, long benches; the lab-VM and phone runs are the owner's.

| Layer | What |
|---|---|
| Unit (cargo) | due list (class G and S routing, overflow, parked records and the slip rebase, a record at the start frame, `fadeZero`, shape endpoints and phase, equal-power power sum within 1e-6, curve-pool-full degrade), group gate (every S2 row, hold on starve, give-up), ring pools, init validation, wire round trips and fuzz |
| Golden (Node, real wasm) | M1-M3 digests unchanged; stamped fades exact to the sample; each seam (cut, three crossfade curves, bridge, loop exit with tail) null against an offline reference that uses the same piecewise-linear control-rate law (tolerance [ARCH §4.4]); the spike's 1,408-case alignment harness as a test; late-group alignment |
| Pure TS | format parse (every limit and message), writer round trip, grid maths properties, rule precedence and nested containers, calibration on the spike's simulated taps, validation on fixture clips |
| Loopback (fake backend) | planner re-plan on a late worker, pool refusal, rebuild reopening a group, hidden tab, hot reload, switch race, beat clock on recorded jitter traces with a fake `ClockMap` (no wall-clock waits) |
| Babylon | each §8 row against the mocks |
| Bench, metered | Z5 and Bench1 scenes (typical, transition, worst; decoded and streamed), STATUS worst case, `mus-split`-style regression at 10% |
| Playwright (wave end) | a sample plays on the grid with the panel's late-group counter at 0; a switch lands on the bar; stinger; segment view draw, drag, undo; rules table; import; calibration |
| Listening pass (owner) | seams, crossfade curves, stinger timing, beat-callback feel, per milestone, headphones |

**Exit checks** (R3, R22): **M4-0** a stamped FADE on one voice among 256 leaves the others bit-identical, and `splitQuanta` reads 0 in the music scenes and in a scene of stamped spatial plays with sends. **M4a** 8 stems start **on the stamp's sample** and null against the offline reference; a late ring delays all equally and they still null; a held group resumes together; a playlist runs 10 minutes with no late group. **M4b** every seam nulls; a never-fits refusal is immediate and a free-ring refusal retries; a stinger lands on its beat. **M4c** callbacks within 1-2 display frames on the trace set; calibration p95 < 10 ms on simulated taps. **M4d** a composer imports eight stems, sets tempo, places cues, builds one rule and auditions it.


## 10. Task breakdown

Level S (senior), M (mid), J (junior). Days are focused human effort, not agent days. **Critical path in bold.** Every task is at most 5 days. Each task's acceptance is the **per-task cadence** of §9 (typecheck, the affected unit tests, `cargo test` of the touched crate, the committed wasm matching its hash); a row that names a golden, bench or spec is satisfied by the wave-end or milestone-end run. Milestones are shippable in order; M4a's pure-TypeScript tasks (F1a, F1b, F3, G1) and the editor's Ed1 have no dependency on M4-0 and may start with it. This is the 2B table: rebuilt under R21 and R24 from the round-1 table (§10.3 lists every change). The record's fold of M4-0 into M4b is settled (R1) and is not an option; the five items that stay on the owner's list are in §11.

### M4-0 in-voice stamped records (25 days, 5.0 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| Z1 | Wire, per-voice family: `shape` word on FADE, SET_PARAMS and STOP, PLAY `fadeZero`, STATUS header to 176 B with every M4 counter (the layout lands once), envelope 1.2 | `audio-wire` schema, `wire.generated.ts`, vectors | - | M | 3 | round trip and fuzz of the longer records; STATUS worst case 16,192 B; stale wasm fails `npm test` |
| **Z2a** | **Core due list: `pop_due` into the due list, `flags2` and link bits, parked records, overflow, regions `Due` and `Curves`** | `audio-core` `due.rs`, `scheduler.rs`, `layout.rs`, `voices.rs` | **Z1** | S | 3 | every per-voice record reaches its voice; non-voice records still split and count `splitQuanta` |
| **Z2b** | **Core class G: FADE, gain-only SET_PARAMS and STOP by a compare in the gain loop, control-rate curve laws, the curve pool, start phase** | `voices.rs`, `curves.rs`, `audio-dsp` `ramp.rs` | **Z2a** | S | 4 | a stamped FADE moves only its voice; unstamped work bit-identical |
| **Z2c** | **Core class S: a voice-local split for every other per-voice record (pitch, low-pass, direction, SET_VOICE_FX, SET_PAUSED, SEEK, SET_LOOP)** | `voices.rs`, `due.rs` | **Z2a** | S | 3 | `splitQuanta` reads 0 for a stamped spatial play with sends and for a `lowpass` ramp; `voiceSplits` counts |
| **Z3** | **Goldens: every M1-M3 digest unchanged; stamped cases re-recorded; exact fade start, power-complementary crossfade, stamped STOP, class S cases; native equals wasm** | `audio-core/tests`, `golden/` | **Z2b**, **Z2c** | S | 5 | parity digests identical; new goldens null against the offline reference |
| Z4 | Main: `commandWriter` shape word and `fadeZero`, voice-table log of un-fired stamped ops, replay with start phase, status reader counters | `core/commandWriter.ts`, `voiceTable.ts`, `replay.ts`, `statusReader.ts` | Z1 | M | 3.5 | a REPLAY re-sends a running curve fade with its current phase |
| Z5 | Metered scenes: one stamped record every quantum, and stamped spatial plays with sends, against their twins; baselines; mixer size check | `audio-bench`, `tools/audio-bench` | Z2b | M | 2 | `check:audio-metered` within 10%; stamped scene within +60k instructions of its twin |
| Z6 | Docs: ADR 0157 amendment text, `implementation-status.md`, guide note on fades | `docs/*` | Z3 | J | 1.5 | `check:links` clean |

### M4a grid, segments, playlists, stems (108.5 days, 21.7 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| F1a | Format: positions, tempo map, cues, regions, tracks with alternatives, `segment` node, ids, limits | `engine/audio/musicFormat.ts`, `musicPosition.ts` | - | M | 4.5 | every §2.3 limit and message; writer round trip |
| F1b | Format: `playlist` and `musicSwitch`, `eventFormat.ts` integration (`NODE_TYPES`, `eventNodes`, `eventClips`, writer, placement rules) | `eventFormat.ts`, `musicFormat.ts` | F1a | M | 3 | `eventClips` lists tracks, alternatives and library clips |
| F3 | `validateMusic`: stem length, rate and channels, gapless, stream-or-decode rule, the peak ring need and never-fits lint, tail longer than loop | `engine/audio/musicValidate.ts` | F1a | M | 3.5 | each lint row of §2.6 on fixture clips |
| G1 | Grid maths: tempo-map compile, position, ticks, seconds and frames, next beat, bar or grid, cue lookup, metre changes | `engine/audio/musicGrid.ts` | F1a | J | 5 | property tests against a naive integrator at 44.1, 48, 96 kHz |
| **W1** | **Wire, gate family: PLAY `gate`, STREAM_OPEN `music`, init `max_music_rings` (ABI 3.0), the `musicRings` and `groupStarts` sections' writers, vectors, fuzz** | `audio-wire` `music.rs` (new), schema files | Z1 | M | 3.5 | round trip and fuzz of the gate field and both sections; hash test |
| **C1** | **Core music ring pool: `InitParams`, layout, `StreamStore` pools, refusal event 4, `musicRings` with epoch, primed and bound, `musicRingsOpen`** | `stream.rs`, `params.rs`, `layout.rs`, `status.rs` | **W1** | S | 4.5 | music and general streams never take each other's rings |
| **C2a** | **Core group table (16 entries, region `Groups`), gate decision, `flags2` group index, give-up** | `audio-core` `groups.rs` | **W1** | S | 4 | state-machine tests for every row of S2 |
| **C2b** | **Core gate in `render_range`: ring binding, start at the stamp or the first ready quantum, slip counters, `groupStarts`, member STOP, RESET** | `voices.rs`, `groups.rs`, `counters.rs` | **C2a**, C1 | S | 4 | 8 stems start on one frame; a slow ring delays all equally |
| C2c | Core group hold on starve: every gated member takes the 5 ms starve fade together and they resume together (R11) | `groups.rs`, `voices.rs` | **C2b** | S | 3 | one dry ring dips the whole group and it resumes aligned (null after resume) |
| C2d | Core slip rebase: a late group's parked records apply relative to its start (R10) | `due.rs`, `groups.rs` | **C2b**, Z2a | S | 1.5 | a fade stamped with a late group lands at the group's start plus its offset |
| **C3** | **Gate goldens: the spike's 1,408-case alignment harness as a test, late-group and held-group null tests, mixed decoded and streamed groups** | `audio-core/tests`, `golden/` | **C2b** | S | 5.5 | null against the reference after a late start |
| **D1a** | **Worker: group open and breadth-first prime (each stem's first 4,096 frames before any ring fills further)** | `decoder/streams.ts`, `protocol.ts` | W1 | S | 4 | 8 stems primed inside the budget of S1 in the worker test |
| D1b | Worker: cancel on re-plan, re-target, `groupOpened`, protocol types, fake-decoder support | `decoder/*`, `fakeDecoder.ts` | D1a | M | 2.5 | a cancelled group frees rings and memory |
| D1c | Worker encoded cache: bytes kept per music instance, refcounted by path, bounded per preset, so a re-prime moves nothing through main (R16) | `decoder/streams.ts`, `core/encodedCache.ts` | D1a | M | 3 | a second prime of the same segment sends no bytes; the budget evicts non-candidate files |
| **P1** | **`SegmentRun`: stems (alternatives, decoded or stream, group id), `PrimeJob`, the `primeGroup` message, one batch per group, pool accounting** | `runtime/music/segmentRun.ts` | **W1**, G1, F1b | S | 5 | loopback: a segment starts on its planned frame |
| **P2** | **Planner: lead 1.25 x Ê + L + Δ̄, grid-point choice, deadline, re-plan, evict a primed successor, never-fits refusal, free-ring retry, Ê rules (not sampled while hidden)** | `runtime/music/planner.ts` | **P1**, D1b | S | 5 | late prime re-plans; refusal keeps the music |
| **P3** | **Counted loop regions, wrap prediction, per-pass alternative hand-over, segment end, grid anchors (musical position plus heard time), rebase on rate change** | `runtime/music/anchors.ts` | **P1** | S | 5 | anchors survive a rate change within 1 frame |
| P4 | Playlist: sequence, random, shuffle, avoidRepeat, `plays`, `rounds`, nesting; natural advance at the exit cue; next always primed | `runtime/music/playlist.ts` | P2, P3 | M | 4 | a long run never shows an unprimed start |
| P5 | Stems: ring release when a stem is silent, solo gain (per-stem automation is 0158's) | `runtime/music/stems.ts` | P1 | M | 1.5 | a silent stem's ring returns at the voice's end |
| P6 | Event runtime: `playNode` for music nodes, `EventInstance.music`, limits, steal, cooldown; `AudioSource` plays music events; `pitch` ignored for music with one warning | `eventRuntime.ts`, `AudioSource.ts` | P1, F1b | M | 5.5 | 0158 limit tests pass for music events; a pitched `AudioSource` plays a music event at rate 1 with one warning |
| P7 | Public API: `handle.music` (state, `nextGrid`), `Audio.horizon`, `Audio.timeAt` (the one task), early `engine.AudioMusic` step, `MusicBackendCaps`, exports | `Audio.ts`, `audioSystem.ts`, `backend.ts`, `myco.ts` | P6 | M | 4 | every §1 row tested; `Audio.time` in `update()` is this frame's |
| P8 | Hot reload of a playing segment: re-prime and swap at the next bar | `runtime/music/reload.ts` | P2 | M | 2.5 | a stem edit swaps at the next bar without a gap |
| P9 | Hidden tab (`play` and `mute` both commit a segment ahead, owner decision 5), context rebuild and worker crash (reopen groups as groups, `musicGroups` hand-off from the Replayer), group timeout | `runtime/music/background.ts`, `core/recovery.ts` | P2, P3 | S | 5 | rebuild and hidden-tab loopbacks keep stems aligned |
| P10 | `Audio.debug().music`: the whole shape of C11 in one task, status reader fields, panel rows, one warning per cause | `debug.ts`, `statusReader.ts`, `AudioDebugPanel.tsx` | P2 | M | 3.5 | each §1.6 counter reaches the panel |
| T1 | Integration tests: late worker, re-plan, refusal, rebuild, hidden tab, hot reload, on a deterministic clock | `music/*.loopback.test.ts` | P9 | M | 5 | all pass without wall-clock waits |
| B1 | Babylon M4a: segments (decoded stamped starts through `waitTime`), playlists, stream warning | `babylonBackend.ts` | P6 | M | 2.5 | §8 rows against the mocks |
| SM1 | Samples: sound-lab `music-intensity` as a segment with stems, flappy `town.mp3` as a streamed segment, presets, a tempo tool | `samples/*`, `tools/` | P6 | M | 3.5 | both load warning-free and play on the grid |
| E1 | Playwright: a sample plays a segment and a playlist; the panel shows no late group | `tests/e2e/audio-music-a.spec.ts` | SM1, P10 | M | 3 | 3 of 3 repeats at wave end |
| D2 | Docs: guide `interactive-music.md` (segments, playlists, stems), status rows | `docs/*` | SM1 | J | 2 | `check:links` clean |

### M4b switches, rules, bridges, stingers (59.5 days, 11.9 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| F2 | Format: `transitions`, `stingers`, `library`, dangling ids, duplicate and shadow warnings, specificity index, limits | `musicFormat.ts`, `musicRules.ts` | F1b | M | 4 | every §2.4 and §2.5 rule and limit |
| **R1** | **Rule engine: tier and nearest-common-parent lookup, exit and enter times under tempo maps, exit clamp, natural advance, fades in beats** | `runtime/music/transitionRules.ts` | **F2**, G1 | S | 5 | §2.4 precedence tables pass, nested containers included |
| R2 | `musicSwitch`: parameter to child, latest wins, return cancels, continue to play | `runtime/music/musicSwitch.ts` | R1 | M | 2 | two changes inside one bar land once |
| **R3a** | **Transition execution: incoming group stamped at exit minus pre-entry, outgoing faded in the voice, post-exit tail under the next segment, ring accounting for two sets** | `runtime/music/transition.ts` | **R1**, P2, Z2b | S | 5 | cut and crossfade seams sample-exact |
| **R3b** | **Bridges: A to bridge to B as two chained plans with sequential priming; decoded bridges need no ring; degrade for a short streamed bridge** | `runtime/music/transition.ts` | **R3a** | S | 3 | a bridge seam is exact; pool-full keeps A and warns |
| R4a | Loop tails: decoded span voices stamped at each wrap; tail refusal | `runtime/music/loopTail.ts` | R3a | S | 3 | a tail rings over the wrap and frees its ring |
| R4c | Clip registry span clips: decode `[start, end)` of an asset as its own clip id, at most 30 s, counted against the ceiling, invalidated on reload (C14) | `core/clipRegistry.ts`, `decoder/clips.ts` | F3 | M | 3 | a span clip plays stamped and frees with its voice |
| R4b | `while` regions: condition read one lead before the loop end, released through the region-release splice | `runtime/music/regions.ts` | P3, R3a | S | 2.5 | a flag set after the commit waits one more pass (stated latency) |
| R5 | Stingers: trigger namespace, quantise, `dontRepeat`, `ifTooLate`, own bus, at most 4 at once, `handle.trigger` | `runtime/music/stingers.ts` | R1, P6 | M | 3.5 | each `ifTooLate` branch; a stinger never changes the grid |
| R6 | `quantize` (`beat` or `bar`) on automation bindings (stamped in-voice ramp at the next grid point) | `music/stems.ts`, `events/automation.ts` | R1, Z4 | M | 2.5 | a bound stem enters on the bar line, sample-exact |
| R7 | Public music seek `handle.music.seek(position)`: validate the position, plan an immediate transition into it, 5 ms crossfade, stamped ([ARCH §3.9]) | `music/handle.ts`, `music/transition.ts` | R3a | M | 1.5 | a seek lands on the stamp at the asked beat; an invalid position returns `{ ok: false, reason: "invalid", permanent: true }` |
| **T2** | **Seam goldens: cut, three crossfade curves, bridge, loop exit with tail, against an offline reference** | `golden/`, `music/seam.test.ts` | R3b, R4a | S | 5 | each seam nulls to 1e-5 |
| T3 | Rule, precedence and nested-container tests; transition loopbacks (late prime, pool full, switch race) | `music/*.test.ts` | R3b | M | 5 | all pass without wall-clock waits |
| Bench1 | Metered music scenes (typical, transition, worst; decoded and streamed; group start), STATUS worst-case test | `audio-bench`, `tools/audio-bench` | R3b | M | 3 | within the allowance of S7; baselines recorded |
| B2 | Babylon M4b: switches at bar boundaries, stingers on decoded clips | `babylonBackend.ts` | R5 | M | 2.5 | §8 rows against the mocks |
| SM2 | Samples: `makeMusic.mjs` stems, sound-lab music scene (explore and combat, a bridge, a stinger, intensity) | `samples/sound-lab`, `tools/` | R5 | M | 4 | scene loads warning-free; every rule audible |
| E2 | Playwright: a switch change lands on the bar; a stinger fires; the debug rule row | `tests/e2e/audio-music-b.spec.ts` | SM2 | M | 3 | 3 of 3 repeats at wave end |
| D3 | Docs: guide chapters on transitions, bridges, stingers | `docs/guide` | SM2 | J | 2 | `check:links` clean |

### M4c beat callbacks and rhythm mode (34.5 days, 6.9 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| **K1** | **Beat clock (design A): prediction from tempo map, anchors and `ClockMap`, window firing, `missed` coalescing, corrections from `groupStarts` and playheads** | `runtime/music/beatClock.ts` | P3, R3a | S | 5 | S4 tolerances on recorded jitter traces |
| **K2** | **`engine.AudioMusic` dispatch, component messages, subscription mask, hook types** | `music/musicSystem.ts`, `engine/core/Component.ts` | **K1** | M | 3.5 | messages arrive before `update`; no cost without subscribers |
| K3 | `positionAt`, `judged`, event types, exports (`Audio.timeAt` is P7's) | `music/handle.ts`, `Audio.ts`, `myco.ts` | K1 | M | 1.5 | every §1 row tested |
| K5 | `handle.onMusic(kind, fn)`: subscribe, unsubscribe function returned, same event and the same `engine.AudioMusic` step | `music/musicSystem.ts`, `Audio.ts` | K2 | M | 0.5 | a script that plays music with `Audio.play` receives beat, bar and cue events; unsubscribing stops them |
| K4 | Deterministic beat-clock tests: fake `ClockMap`, jitter traces, tempo change, seek, hidden-tab gap | `music/beatClock.test.ts` | K1 | M | 4 | 0 missed, doubled or phantom over the spike's traces |
| Rh1 | `audio.rhythmMode`: numeric `latencyHint`, latency read-back and the `reliable` rule, `Audio.latency`, rebuild on a setting change, held callbacks during recovery | `core/context.ts`, `settings.ts`, `Audio.ts` | K1 | S | 4.5 | toggles through the rebuild path; recovery re-entry is stamped |
| Rh2 | `Calibration.fromTaps`, `Audio.calibration`, persistence through `Storage` per output device, re-ask on device change | `music/calibration.ts` | K3 | J | 4 | p95 error under 10 ms on the spike's simulated taps |
| Rh3 | Calibration and tap-game sample scene | `samples/sound-lab` | Rh2 | M | 4 | the offset persists across a reload |
| B3 | Babylon M4c: callbacks from the main-side clock, rhythm-mode warning | `babylonBackend.ts` | K2 | M | 2 | §8 rows against the mocks |
| E3 | Playwright and loopback: callbacks reach a script; the calibration flow | `tests/e2e/audio-music-c.spec.ts` | Rh3, K2 | M | 3.5 | 3 of 3 repeats at wave end |
| D4 | Docs: guide chapter on callbacks and rhythm mode | `docs/guide` | Rh3 | J | 2 | `check:links` clean |

### M4d editor, samples, listening pass (63 days, 12.6 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| Ed1 | Peaks service: decode through the worker to mip-mapped peaks, cache | `editor/music/peaks.ts` | - | M | 4.5 | 8 three-minute stems computed without blocking the editor |
| **Ed2** | **Segment view: stem lanes, bar and beat ruler from the tempo map, tempo and metre lane, zoom, scroll, playhead** | `editor/music/SegmentView.tsx` | Ed1, G1 | M | 5 | grid lines at tempo and metre changes |
| **Ed3** | **Segment view editing: drag cues, regions and tempo markers with snapping, undo** | `editor/music/segmentDrag.ts` | **Ed2** | M | 5 | every drag undoable; positions stay musical |
| Ed4 | Segment panel: tempo from length and bars, tap tempo, stem list (solo, mute, gain, alternatives), cue and region forms | `editor/music/SegmentPanel.tsx` | Ed2 | M | 4 | forms round-trip through the writer |
| Ed5 | Transport and audition through the real backend: from a cue or bar, loop with tail, hot-reload hook | `editor/music/transport.ts` | Ed2, P8 | M | 4.5 | audition names its backend and plays from any bar |
| Ed6 | Rules table: from by to grid, wildcards, effective-rule highlight, why readout | `editor/music/RulesTable.tsx` | R1 | M | 5 | the highlight equals `transitionRules` for every pair |
| Ed7 | Rule editor, lint (shadowed, unreachable, duplicate), audition a transition from a chosen position | `editor/music/RuleEditor.tsx` | Ed6, Ed5 | M | 4.5 | lint rows of §2.4; audition lands on the rule's exit |
| Ed8 | Event tree and node properties for music nodes: ids, stinger list with a trigger button, library | `editor/event/*` | F2 | M | 5 | writer round trip; id uniqueness enforced |
| Ed9 | Import: drop files onto a segment, read `acid`, `cue`, `smpl` and Ogg hints, lint on import | `editor/music/import.ts` | F3 | J | 4.5 | hints read from fixtures; lint rows of §2.6 |
| Ed10 | Project Settings > Audio: music rings and rhythm mode with the preset | `AudioSettingsSection.tsx`, `audioSettingsModel.ts` | W1, Rh1 | M | 2.5 | edits persist; preset comparison includes `musicRings` |
| Ed11 | Playwright: segment view, rules table, import, settings | `tests/e2e/audio-music-d.spec.ts` | Ed3, Ed7, Ed9 | M | 5 | 3 of 3 repeats at milestone end |
| L1 | Listening-pass document, scenes, lab-VM and phone instructions | `listening-pass.md` | SM2, Rh3 | J | 2.5 | every owner item has a key or scene |
| L2 | Samples final: flappy music in play, sound-lab scene polish, `implementation-status.md` | `samples/*`, `docs` | L1 | M | 3 | samples warning-free and non-silent |
| L3 | Listening-pass rework: seams, curves, stinger timing, beat feel (the owner's items) | as the items say | L1 | S | 5 | owner sign-off block filled |
| D5 | Docs: API reference, ADR amendments 0158 and 0097, guide final | `docs/*` | L2 | J | 3 | `check:links` clean |

### 10.1 Total, reserve and the critical path

Tasks, summed by script from the rows: M4-0 25 + M4a 108.5 + M4b 59.5 + M4c 34.5 + M4d 63 = **290.5 days** (58.1 person-weeks at 5 d). By level: S 99.5 d, M 164.5 d, J 26.5 d. The longest chain inside each milestone, summed because milestones ship in order, is **109.5 days** (M4-0 16.5, M4a 29.5, M4b 22, M4c 18, M4d 23.5; about 22 weeks if nothing waits). Two seniors are the floor; the core, player and clock chains should not share one person.

**The reserve: 20% (owner decision 1, 2026-11-11).** The named items are the 20% column below, 58 days. No scope cuts are taken: `while` regions and loop tails, the rules table's audition and lint, the rhythm sample and the Babylon beat callbacks all stay. Not taken: a reserve of a third (96 days, 386.5 total, 77.3 person-weeks), the option I recommended; the third column is kept for reference.

| ID | What the reserve is for | d, a third (not taken) | **d, 20% (chosen)** |
|---|---|---|---|
| RS1 | Listening-pass rework beyond L3: seams, curve laws, stinger timing, beat feel | 12 | 4 |
| RS2 | Real-device beat clock, `outputLatency` honesty and the phone prime lead (the lab VM and phone runs are the owner's) | 14 | 14 |
| RS3 | Group-gate corner cases: rebuild, 44.1/48 kHz, virtual members, seek during a wait, worker crash mid-prime | 10 | 3 |
| RS4 | In-voice hot path over its gates: wasm size and speed, `wasm-opt`, metered baseline moves | 8 | 2.5 |
| RS5 | Editor rework after a composer trial: drag, zoom, snap, undo, waveform speed for 8 long stems | 14 | 14 |
| RS6 | Babylon surprises: HTML5 streamed stems, browser quirks | 6 | 2 |
| RS7 | WebKit and Firefox at milestone ends: AudioWorklet and latency quirks | 10 | 3 |
| RS8 | Wave-end integration: flakes, merges in `eventRuntime.ts` and `voices.rs`, e2e repeats | 12 | 12 |
| RS9 | Format gaps from real DAW bounces: MP3 padding, odd rates, tails | 6 | 2 |
| RS10 | Worker memory on low: shared encoded copies if 8 stems hold too much | 4 | 1.5 |
| | **Total reserve** | **96** | **58** |

| | Tasks | Reserve | Total days | Person-weeks |
|---|---|---|---|---|
| **With 20% (chosen)** | 290.5 | 58 | **348.5** | **69.7** |
| With a third (not taken) | 290.5 | 96 | 386.5 | 77.3 |

### 10.2 Line by line against the record's provisional estimate

The record (revision 2) priced 24.5 person-weeks of features and called the whole **45-55**. Mapping my 2B rows onto its lines:

| Record line | Record pw | My rows | d | pw | Why it differs |
|---|---|---|---|---|---|
| Format and validation | 1.5 | F1a, F1b, F3, F2 | 15 | 3.0 | ids, limits, rules, stingers, library, two-tier lint with the peak ring need |
| Grid maths | 1 | G1 | 5 | 1.0 | as priced |
| Main-side player, rules, stingers, planner | 4 | P1-P6, P8-P10, R1-R7, R4c | 68 | 13.6 | the record priced about twice M3's zone planner (C5, 8.5 d); the table has the prime and commit machine, anchors with rate rebase, nested playlists, hot reload, hidden tab and rebuild, `musicSwitch`, transitions with pre-entry, tails and bridges, `while`, stingers, quantised ramps, span clips, one debug task |
| Streams: prime protocol, pool, slip counter | 2.5 | W1, C1, C2a-C2d, D1a-D1c | 30 | 6.0 | the group gate with hold on starve and slip rebase replaced the slip counter; the worker needs a group open, breadth-first prime, cancel and an encoded cache |
| In-voice ramps | 1.5 | Z1, Z2a-Z2c, Z4 | 16.5 | 3.3 | a due list, both classes, the curve pool and REPLAY |
| Beat clock and API | 1.5 | P7, K1, K2, K3, K5 | 14.5 | 2.9 | includes the early frame step, `timeAt` and component dispatch |
| Rhythm mode and its sample | 2 | Rh1, Rh2, Rh3 | 12.5 | 2.5 | close |
| Fallback | 1 | B1, B2, B3 | 7 | 1.4 | as priced, spread over three milestones |
| Editor | 7.5 | Ed1-Ed8, Ed10 | 40 | 8.0 | waveform peaks, tempo-aware snapping, undo and preview through the backend were the senior RFC's 2 pw; the record's 7.5 held none of them |
| Import hints | 0.5 | Ed9 | 4.5 | 0.9 | a RIFF reader and lint rows |
| Samples and listening pass | 1.5 | SM1, SM2, L1, L2, L3 | 18 | 3.6 | two sample sets and a rhythm scene plus one rework row |
| Not in the record (the senior RFC's about 12 pw) | 12 | Z3, Z5, C3, T1-T3, K4, Bench1, E1-E3, Ed11, D2-D5, Z6 | 59.5 | 11.9 | goldens and replay, benches, tests, e2e, docs |
| **Tasks** | **24.5 (+12)** | | **290.5** | **58.1** | |
| Reserve, 20% (chosen; a third not taken: 96 d, 19.2 pw) | in the multiplier | RS1-RS10 | 58 | 11.6 | |
| **Total** | **45-55** | | **348.5** | **69.7** | **14.7 pw over the top of the record's range** |

**The honest reading.** The tasks alone are 58.1 pw, 3.1 over the range's top; the player is 13.6 pw against the record's 4, and the wire, gate, worker, hold and ramp work 9.3 against 4. The record's 45-55 holds only with no reserve and the player near its 4 pw, which neither table supports. The owner chose a 20% reserve (the architect's case: M3 drew none of its 14 days); I had argued for a third (the listening pass, the phone and the editor are untested).

**Calibration from M3** (`build-log.md`, which logs agent time, not human days): M3's table days against per-kind work, which these rows copy: wire A1 5 d for five records and STATUS, core bed A4 7, zones C3 9, ambisonic voice B3 6, goldens and benches A7 4.5, C7 4.75, D6 3.75, editor E1 4, E3 5.5, E4 4, e2e E9 4, samples E8 6.5, listening E10 2. M3's lessons stay in: a leaf with an unmeasured bound stays with its lead, e2e catches wiring bugs unit tests miss, the metered gate and mixer size are checked per task.

**Cuts:** the owner took none (2026-11-11). `while` regions and loop tails (R4a, R4b, R4c), the rules table's audition and lint, the rhythm sample scene and the Babylon beat callbacks all stay.

### 10.3 Round 1 to 2B to the owner's decisions

| Milestone | Round 1 d | 2B d | Change |
|---|---|---|---|
| M4-0 | 25.5 | 25 | -0.5 |
| M4a | 101.5 | 108 | +6.5 |
| M4b | 65 | 58 | -7 |
| M4c | 35.5 | 34 | -1.5 |
| M4d | 63.5 | 63 | -0.5 |
| **Tasks** | **291** | **288** | **-3** |

Round 3 (owner decisions, 2026-11-11) adds **2.5 days: 290.5 in all**: P6 +0.5 (pitch ignored for music), K5 new 0.5 (`handle.onMusic`), R7 new 1.5 (public seek); mute under a hidden tab is 0 (inside P9). M4a 108.5, M4b 59.5, M4c 34.5, M4-0 and M4d unchanged.

Row by row (days): Z1 3.5 to 3; Z2a 4 to 3; Z2b 5 to 4; Z2c new 3 d; Z3 4.5 to 5; Z4 4 to 3.5; Z5 3 to 2; W1 4 to 3.5; C2a 5 to 4; C2b 4.5 to 4; C2c new 3 d; C2d new 1.5 d; C3 5 to 5.5; D1b 3 to 2.5; D1c new 3 d; P2 4 to 5; P5 3 to 1.5; P7 3.5 to 4; P9 4.5 to 5; P10 3 to 3.5; R2 3 to 2; R3b 5 to 3; R4a 4 to 3; R4c new 3 d; R4b 4 to 2.5; R5 5 to 3.5; Bench1 4 to 3; K3 2.5 to 1.5; Rh1 5 to 4.5; Ed10 3 to 2.5; P11 dropped (2 d). The reasons are in §12: the architect's cuts that remove duplication (R21: one debug task, one `timeAt`, one wire task per record family) or rest on a simpler design (R2: one due list, no op table; control-rate laws; a bridge as two chained plans; the release splice that exists), the rows the rulings make firm (Z2c, R4c, D1c, the group hold C2c, the slip rebase C2d), and P12 dropped (R11). Where I kept a row against a cut (Z1 3 not 2.5, Z2 at 10 not 9, Z4 3.5 not 3, P9 5 not 6, R4c 3 not 2, C2a-C2b 8 not 7) §12 gives the reason.

## 11. Where the record is wrong or under-specified, and the owner's decisions

Anything here that changes behaviour, scope or schedule goes to the owner through the coordinator; I have taken the cheapest reading and say which.

**Settled and written back**
1. **A stamped PLAY does not split the quantum** (`scheduler.rs:38-40`, `:57`, `:218-221`; `voices.rs:375-396`), so revision 2's correction is wrong for PLAY and spike S4 was right. The queued per-voice records split; a stamped play with sends is followed by a stamped SET_VOICE_FX, so M4-0 has consumers outside music (R1). ADR 0167 amends the record.
2. **The record's lead formula** max(horizon, 1.25 x EMA) cannot meet its own deadline; the lead is 1.25 x Ê + L + Δ̄ (R12, [ARCH §4.1]); ADR 0167 amends the record.

**Under-specified, my reading stated**
3. **ABI is 3.0** (the init signature changes, as 0162 R6 did for 2.0), envelope 1.2, STATUS 176 B with 192 B spare (§4.4); the next growth raises the shell's `STATUS_BUFFER_BYTES`.
4. **Exit, pre-entry, post-exit:** a rule's `exit` is clamped to the exit cue when it would fall after it; pre-entry applies only to `enter: "entryCue"`; a natural playlist advance ignores the rule's `exit` and leaves at the exit cue (§2.4). The first is Wwise's reading; the others are mine.
5. **Names and vocabulary the record left open:** `plays` and `rounds` (not `loop`, a boolean elsewhere); bridge and stinger segments in a container's `library`; rule endpoints are direct children; the `while` operators `is`, `atLeast`, `below` (the format has no condition vocabulary to reuse).
6. **Pool arithmetic, corrected by R15.** The record's pool sizes cover streamed stems; decoded stems, decoded bridges (up to about 30 s) and decoded tails need no ring, so "no bridge on low" was wrong. What a preset can do is the **peak** ring need of a sequence (§2.6); a need above the pool is refused at once (R14). A streamed stinger, hot reload (the reloaded segment primes beside the playing one) and a per-pass alternative on a streamed stem (a primed hand-over at each wrap, because a loop cannot jump into a different file) each add rings at their peak.
7. **`quantize` on automation cannot be a core binding** (the core evaluates bindings continuously): a bound stem is evaluated on main at the grid point and applied as a stamped 20 ms in-voice ramp (§2.3).
8. **Mixer size** +14 KB (est.) against the senior RFC's +8 KB; the gate is a tripwire (CLAUDE.md, R23), recorded in the build log (ADR 0167 carries the allowance corrections).
9. **`Audio.play(music, { at })` closer than the lead** (R12): the ruling says it lands "on the next allowed grid point"; before the first segment there is no grid, so I read it as the earliest stampable frame, which then anchors the grid. If the coordinator meant something else (a bar line of what?) the wording changes in the guide only.
10. **Not specified by the record, taken as stated in §1:** a quantised `stop` (none; `stop(fade)` only); `Nothing` as a rule source or target (none; the default rule governs a start); stems of one segment share a file rate, segments need not; a held group's parked records are capped at 128 ([ARCH §5.3] set it after round 2B).

**Where I think a ruling is incomplete**
- **R16 as written is unbounded.** "The encoded bytes of a music instance's files for its lifetime" is every file in the event tree: a score of 20 segments of 8 MP3 stems is about 700 MiB. I took it **with changes** (§4.6): refcounted by path for the instance's lifetime, but evicting files of segments that are neither playing, primed nor a candidate successor, inside the per-preset budget of the lint (48 / 96 / 160 MiB, est.). The architect should confirm the numbers in [ARCH §6].
- **R11's timeout value** is the architect's; the core needs a constant (`GROUP_GIVE_UP_FRAMES`) to abandon a group; [ARCH §4.3] and §5.3 set it to 1 s after the stamp, or 1 s held.

**Owner items, decided 2026-11-11** (every recommendation accepted)

| # | Item | Decision | Day cost, where |
|---|---|---|---|
| 1 | Estimate and reserve | a 20% reserve, 58 d; no scope cuts | none; §10.1 |
| 2 | No pitch on music | a pitch automation binding on a music track is a validation error (dropped); `AudioSource.pitch` and `EventOptions.pitch` are ignored for music with one warning | +0.5, in P6 |
| 3 | `handle.onMusic(kind, fn)` | taken; returns an unsubscribe function; same event and step as the component messages (§1.2) | +0.5, row K5 (M4c) |
| 4 | A public music seek | taken: `handle.music.seek(to)` returns a `MusicSeekResult` (§1.2); behaviour is [ARCH §3.9], C20 | +1.5, row R7 (M4b) |
| 5 | Hidden tab under `mute` | commit ahead as under `play`, so music keeps its place | 0, in P9 |
| 6 | Starve behaviour (R11) | the core group hold stands: the whole group dips and resumes together | in C2c (3) |
| 7 | The record's corrections | go into the amending ADR 0167 (PLAY does not split, the lead formula, the allowances) | none |

## 12. Resolutions: every item of `review-round2-architect.md`

**Issues**

| # | Disposition | What changed, or why not |
|---|---|---|
| 1 `primed` epoch | taken | `musicRings {streamId, epochFlags}`, primed only in the current epoch (§4.4; R7) |
| 2 `groupStarts` per group | taken | 16 B per group, at most 8 per STATUS (§4.4) |
| 3 route by record | taken | class G and class S, every per-voice record in its voice (§3.1; R2); row Z2c |
| 4 rhythm refusal | taken | removed (§1.5; R19) |
| 5 keep M4-0 | taken | R1; the fold is not an option in §10.2 |
| 6 task table | taken with changes | cuts taken: Z5, P5, K3, R2, R3b, R4b, R5, Bench1, D1b (partly), P10 and P11 merged, `timeAt` once (R21). Kept against the architect: **Z1 at 3** (the shape word touches three records plus `fadeZero`), **Z2 at 10 not 9** (class S shares nothing with the gain-loop compare: it splits a voice's whole render with its sends and bed taps), **Z4 at 3.5** (REPLAY carries the start phase, R5), **C2a and C2b at 8 not 7** (the give-up and the 16-entry table), **P9 at 5 not 6** (the starve resync left, R11), **R4c at 3 not 2** (id allocation, ceiling accounting, reload invalidation and a worker decode path). Added: Z2c, R4c, D1c, C2c (hold), C2d (R10 rebase); P12 never entered the table (§10.3) |
| 7 bridges on low | taken | decoded bridges cost no ring; the lint counts the peak (§2.6; R15); R3b is two chained plans |
| 8 `at` closer than the lead | taken with changes | §1.3; no grid exists before the first segment (§11 point 9) |
| 9 `while` commit | taken | L + Δ̄ + 10 ms unless a stem changes file at the wrap, then a prime lead (R13; S14) |
| 10 tails as span clips | taken | R4a is span voices, R4c the registry (§2.3, §10) |
| 11 M4a exit check | taken | on the stamp's sample, nulling (§9; R22) |
| 12 group ids freed | taken with changes | main allocates 1..1023 skipping live ids; the core frees an entry at the start or the report, 16 entries (§3.1; R8, R9) |
| 13 REPLAY of a running shaped ramp | taken with changes | the architect preferred a linear remainder from the computed value; R5 rules a start phase, so REPLAY re-sends the fade with its phase (§3.1, §4.2); their alternative rejected by the ruling |
| 14 `primeGroup` and the backend seam | taken | §4.6 |
| 15 `handle.onMusic` | taken (owner decision 3) | §1.2, row K5 |

**My contracts' statuses, C1-C18**

| # | Status given | Disposition |
|---|---|---|
| C1 music ring class | met | taken; event 4 (R7), `max_music_rings` in the init (§4.5) |
| C2 primed bits | partly | taken: the epoch and bound flag (§4.4) |
| C3 sync group | met | taken with changes: 10-bit id and 6-bit size (R8), table of 16 (R9), decoded singles ungated |
| C4 group-start event | partly | taken: per group, plus an ungrouped late-start counter (§4.4) |
| C5 fade law, start phase | partly | taken with changes: one `shape` word on FADE, SET_PARAMS and STOP (law and u0), `fadeZero` on PLAY, `from` dropped (§4.1, §4.2; R5) |
| C6 curve state | met | taken: the 255-entry curve pool and the spare-byte link (§3.1; R4) |
| C7 split counter | met | taken: `splitQuanta` and `voiceSplits` (R3) |
| C8 `primeGroup` | partly | taken: §4.6 with the per-instance encoded cache (R16) |
| C9 settings | met | taken: a change goes through the rebuild path (§1.5) |
| C10 backend seam | partly | taken: `MusicBackendCaps` and the operations (§4.6) |
| C11 debug fields | partly | taken: §1.6, one task (R21) |
| C12 input mapping | met, architect changes | taken: `timeAt` raw, `judged` carries calibration, `calibrationStale` (§1.3; R18) |
| C13 validation | met | taken |
| C14 span clips | not met | taken: row R4c (R15) |
| C15 callback fields | met | taken, with `skippedCues` (R20) |
| C16 Replayer hand-off | partly | taken: the `musicGroups` hand-off, in P9 |
| C17 beat system | met, architect changes | taken: `engine.AudioMusic` (R17; the architect's `engine.AudioBeat` is dropped by the ruling), after `engine.Lobby` and `engine.PredictionSmooth`, before `engine.UpdateScripts` |
| C18 positions | met | taken: 960 ticks per beat; one conversion in `musicGrid.ts`; the rounding rule of §2.2 |

**Rulings R1-R24** are applied where they touch this file: R1 (§10.2), R2-R4 (§3.1, §4.4), R5 (§4.1, §4.2), R7-R9 (§4.1, §4.4), R10-R11 (§3.1; rows C2c, C2d), R12 (§1.3), R14-R15 (§2.6, §11), R16 (§4.6), R17 (§6), R18-R20 (§1.3, §1.5, §2.5), R21 (§10), R22 (§9), R23 (§5), R24 (§10).
