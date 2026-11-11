# 0166 interactive music: API, data models, formats and plan (M4), revision 1

Senior engineer's design for ADR 0166 (Accepted, revision 2 plus the owner decisions). Companion to `architecture.md` (cited **[ARCH §n]**: timing, memory, failure behaviour, observability, platforms), to 0162's `api-and-models.md` (the shape this file follows) and to 0157's. This file owns the public API, settings and the event file format with its limits and ids, internal models, every byte layout, native and TypeScript layout, editor integration, the Babylon mapping, the test plan and the task table. What I need from the architect is numbered **S1-S14** in `contracts-senior.md`; I do not restate timing, memory or failure rules here.

Units: seconds on the heard clock (`Audio.time`'s base) unless a field says otherwise; audio frames at the context rate; `performanceTime` is a `performance.now()` value in milliseconds (what `event.timeStamp` holds); linear gain; musical positions are bar, beat and tick (§2.2); little-endian; byte offsets are from the first byte of a record, head included. Line numbers cite the tree at 2026-11-11. Owner rules applied: follow Wwise and FMOD (inline), no feature flags and no migration (the samples change, §1.7), and no run that cannot change a decision (§9). "Display frame" and "audio frame" are always spelled out.

## 1. Public API

Everything is exported from `src/myco.ts` (§6). Nothing names Babylon, three.js, Rapier or Howler (ADR 0010).

### 1.1 Types

```ts
/** `"beat"`, `"bar"`, or every n-th: `{ every: "bar", n: 2 }` (n 2..64). Wwise's grid; FMOD's quantisation. */
export type GridSpec = "beat" | "bar" | { every: "beat" | "bar"; n: number };
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
}
```
`handle.music` is `undefined`, never an empty object, for non-music events. The getters share one snapshot per display frame, recomputed on first read (no allocation after it). `setParameter` already exists; for a `musicSwitch` the latest call before the quantised exit wins, and setting it back to the playing child cancels the change. `handle.stop(fadeSeconds)` stops all stems with one in-voice fade; it is never quantised and is allowed in rhythm mode (it ends callbacks). `handle.fade`, `release` are as 0158. A music event is flat: its `spatial` key is ignored with a problem.

### 1.3 `Audio` additions

```ts
Audio.horizon: number;       // seconds, read-only: the earliest heard time a stamped start is exact for a DECODED clip (now + lookahead). Not a promise for a streamed clip: those need priming. Fallback backend: Audio.time.
Audio.timeAt(performanceTime: number): number;   // heard time of a performance.now() instant (event.timeStamp); linear map through ClockMap; Audio.time before the clock has an estimate. Public without rhythm mode.
Audio.calibration: number;   // seconds, read/write, default 0: SUBTRACTED from an input's offset (judged = offset - calibration)
Audio.latency: { base: number; output: number; limiter: number; total: number };  // seconds, read-only, from the context
Audio.rhythmMode: boolean;   // read-only: the project setting
```
`Audio.play(music, { at })`: `at` is the heard time the entry cue is heard; the pre-entry starts early. Closer than the prime lead: it starts as soon as primed, with one warning. `Audio.time` read in `update()` is now this display frame's value (the early step, §6); before it was last frame's, so scripts that subtracted a frame lose nothing, they gain accuracy.

### 1.4 Component messages (M4c)

`LifecycleHooks` (`Component.ts:139`) gains `onMusicBeat?(e: MusicEvent)`, `onMusicBar?(e)`, `onMusicCue?(e)`, with `MusicEvent` declared in `engine/audio/musicTypes.ts` (the engine core imports no plugin, as for `onTriggerEnter`). They go to the active `GameBehavior`s on the node of the `AudioSource` that plays the music (the dispatch style of `PhysicsCore.notify`: look up the hook, `try`, `console.error` on a throw). **Phase:** the built-in system `engine.AudioMusic`, phase `update`, `after: ["engine.Lobby","engine.PredictionSmooth"]`, `before: ["engine.UpdateScripts"]` (the slot of `engine.UIDocumentEvents`, `UIDocument.ts:998`). A node with no component that defines a hook costs nothing: the subscription mask is recomputed when the node's component list changes, and predictions run only for subscribed instances. After a gap longer than one beat each kind fires once with `missed: n`. A script that calls `Audio.play` itself has no node and gets no callbacks; it polls `handle.music` (§11, point 6).

### 1.5 Calibration (M4c)

```ts
export const Calibration: { fromTaps(offsets: readonly number[], options?: { warmup?: number }): CalibrationResult };
interface CalibrationResult { offset: number; spread: number; confidence: number; used: number; discarded: number; steady: boolean }
```
`offsets` are raw `MusicPositionAt.offset` values in seconds. The first `warmup` (default 4) are dropped; `offset` is the median of the rest and `spread` their MAD (a plain median is as good as any trimming on the spike's simulated taps, and a mean is unusable with misses). `confidence = clamp01(1 - spread / 0.040) x min(1, used / 16)`; `steady` is spread <= 40 ms and used >= 8 (the spike's "retry" threshold, est.). Persistence uses `Storage` (ADR 0024), namespace `settings`, key `audio.calibration.<sinkId or "default">`; the engine re-reads it on the context's device event and clears `Audio.calibration` to 0 on an unknown device so a game can re-ask. Rhythm mode (`audio.rhythmMode`) asks the context for `latencyHint: 0`, reads `baseLatency` and `outputLatency` back into `Audio.latency`, refuses asap music changes (a rule with `exit: "immediate"`, or a switch change it would apply at once) with one warning, and promises no absolute latency.

### 1.6 Debug and counters

`Audio.debug()` gains `music: MusicDebugRow[]` and `musicTotals`. A row: `id`, `asset`, `state` (`priming | playing | transitioning | ending`), `segment`, `bar`, `beat`, `pending` (`{ to, rule: index, ruleKey: "from>to", tier: 1..4, exit, enter, time }` or null), `stems` (`{ name, primed, streamed, ring }[]`), `replans`, `refusals`, `lateGroups`, `lastSlipFrames`, `ringsUsed`, `leadMs`. Totals: `poolUsed`, `poolSize`, `lateGroups`, `streamStartsLate`, `maxSlipFrames`, `splitQuanta`, `timedOverflow`, `primeEmaMs`, `refusals`. Each refusal, re-plan and slip also warns once per cause (`poolFull`, `primeLate`, `groupLate`, `stemFailed`, `tailRefused`, `rhythmAsap`, `lengthMismatch`, `noGapless`); the panel's Music section shows the rows (the live monitor).

### 1.7 Compatibility

| Member | Change |
|---|---|
| `Audio.time` in `update()` | this frame's value (was one frame old); no flag |
| `Audio.play(event, options)`, `playOneShot` `at` | unchanged; stamped starts as before |
| `AudioSource` | plays a music event like any event; `loop`, `spatial`, distances come from the event and are ignored for music |
| `handle.panner`, `occlusion` | the first playing stem's |
| `Audio.debug()` | gains `music`, `musicTotals`; existing rows unchanged |
| Stamped `SET_PARAMS`, `FADE`, `STOP` | apply inside the voice (M4-0); stamped goldens re-recorded, unstamped bit-identical |
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

Music nodes extend `NodeBase`. Placement: a music node is the event's root or a child of a music container (`playlist`, `musicSwitch`); a music node under any other container, or a 0158 node under a music container, is dropped with a problem. `pitch`, `pitchRandom`, `delay`, `range`, `fade` on a music node are read and ignored (one problem each); pitch automation on a stem is dropped (the grid assumes rate 1). **`id`** is required on every music node: `^[A-Za-z0-9_-]{1,48}$`, unique per event (checked like `parseParameters`), also on `library` segments. `NodeBase` gains optional `id` for every type.

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

**`segment`:** `gridOffset` (seconds >= 0, default 0: the pickup before bar 1, i.e. the pre-entry when the entry is `1:1:0`), `tempo` (1..64 markers, first at `1:1:0`, default one marker of 120 bpm 4/4), `cues` (<= 64, unique names; `entry` and `exit` name the entry and exit cue, defaults the cues of those names, else the grid start and the end), `regions` (<= 16: `id`, `from`, `to` positions, `count` 0 = forever or 1..64, optional `while`, optional `tailBeats` 0..16), `tracks` (1..16, the stems). **Track:** `name`, `clip`, `alternatives` (<= 8 clips of equal length; `pick` `random | sequence`, default `sequence`, one pick per pass), `volume`, `bus` (a bus name, default the event's), `automation` (the 0158 `Automation` with an optional `quantize: "beat" | "bar"`, targets `volume` and `lowpass`; a quantised binding is evaluated on main at the grid point and applied as a stamped 20 ms in-voice ramp, so the stem does not follow the parameter between grid points). `while` is `{ parameter, is }` for a labelled parameter, or `{ parameter, atLeast }` or `{ parameter, below }` for a numeric one (the event format has no condition vocabulary today; this is the minimum, §11 point 7). **`playlist`:** `children` (segments or containers, <= 256), `mode` `sequence | random | shuffle` (random: weighted by `weight`, `avoidRepeat`; shuffle: a bag, each once per round), `rounds` (whole-list repeats, 0 = forever, default 1), per child `plays` (1..64, default 1). **`musicSwitch`:** `parameter` (labelled, local or global), `default`, children keyed by `value`; unlike `switch` there is no `onChange`: the rules decide. The whole event keeps `MAX_EVENT_NODES` 1,024 and `MAX_EVENT_DEPTH` 16; `library` segments count as nodes. Tempo markers <= 64, cues <= 64, regions <= 16, stems <= 16, alternatives <= 8, rules <= 256, stingers <= 32, `library` <= 64.

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

`stingers` on a container: <= 32 of `{ trigger, segment (a library id), at, dontRepeat, ifTooLate, volume?, bus? }`; `at` is a `GridSpec`, `"immediate"` or `{ "cue": name }` (the next occurrence in the playing segment); `dontRepeat` seconds (default 0); `ifTooLate` `nextGrid | playNow | skip` (default `nextGrid`, with a warning when it fires). Stinger segments should be decoded clips; a streamed stinger takes a ring for its length. `trigger` names are one namespace per event; with several matches the deepest container above the playing segment wins, then list order. A stinger plays on its own voices over the music and never changes the grid. `library` (<= 64 segments) holds bridge and stinger segments, which are not playlist or switch children.

### 2.6 Validation in two tiers

**Parse** (`parseAudioEvent`, pure, never throws, as today): shapes, clamps, limits, ids, dangling references, duplicates, placement. **Clip facts** (`validateMusic(asset, facts)`, pure over an injected `facts(path)` returning `{ frames, rate, channels, gapless }` from the decoder's `Info`): run at the first play (warn once) and live in the editor. `gapless` is `Info.frames !== null`; the decoder already trims encoder delay and padding for MP3 with a Xing, Info or LAME header, Vorbis and AAC (`loop_seam.rs`), so the check is that the length is stated. Lint rows: stems of a segment differ in length (beyond 1,024 frames: the segment refuses to play; within: the shortest wins, warn), rate or channel count; an MP3 stem without a length header (`noGapless`); a streamed FLAC or WAV stem on `low` (warn: ~190 MiB of encoded data for 8 stems); more streamed stems than half the preset's pool (a crossfade needs two sets: "needs N rings; this preset has M"); a decoded stem over 30 s; a silent stem; a tail longer than its loop; `alternatives` of unequal length; a cue past the audio. The editor shows the same rows (§7).

### 2.7 Import hints

When a clip is added to a segment the editor reads a WAV's `acid` (tempo, beats, metre), `cue ` plus `LIST/adtl` labels and `smpl` loops, and Ogg `BPM` and `LOOPSTART` comments (a small RIFF reader in TypeScript beside `loop_points.rs`'s `smpl` and Ogg path). They are suggestions written into the event once; the event file is authoritative. "Tempo from length and bar count" and tap tempo are editor functions (§7).

## 3. Internal models

Writers: **main**, **sys** (the per-frame audio system), **status** (the mirror), **core** (the worklet).

### 3.1 Core tables

| Table | Home | Contents | Size |
|---|---|---|---|
| Music rings | `Streams` region, indices `G..G+M` after the `G = max_mixed/16` general rings (4..16) | 307,200 B each (`RING_BYTES`); `STREAM_OPEN` with the `music` flag takes only these, others never do | M = 8 / 12 / 16: 2.34 / 3.5 / 4.7 MB |
| Timed table | new region `Timed`, before `Arena` | 255 entries of 128 B: owner voice id, op count, shaped-ramp state (24 B), up to 4 timed ops of 24 B (`frame u64`, `kind u8`, `flags u8`, `a f32`, `b f32`, `frames u32`) | 32,640 B on every preset |
| Group table | core-state area after the scheduler's | 8 entries of 96 B: id, size, present count, state, stamp frame, start frame, 16 member voice ids | 768 B plus a header; asserted to fit `CORE_STATE_BYTES` |
| Voice slot | unchanged | 192 B by my count of its fields (`voices.rs:124-166`: 4 ramps of 16 B and an 80 B panner; the assert at `:167` is `<=`, and the field comment says it packs into the layout size): no field grows. `reserved: u8` becomes the **Timed link** (entry + 1, 0 none); `flags2` bit 1 `GATED` | 0 |

The slot has no room for a pending ramp, which is why the in-voice records live in a side table, as the fx pool does for filters. A voice with no Timed entry and no `GATED` bit renders exactly as today, so unstamped work stays bit-identical. A stamped STOP, FADE or SET_PARAMS (gain and pitch bits only) for a voice goes to its Timed entry; when the table or the entry (4 ops) is full it falls back to the pending queue and `timedOverflow` counts. A stamped SET_PARAMS with `dir`, `lpHz`, `score`, `bus` or `flags` bits, SET_PAUSED, SEEK and SET_LOOP stay queued and split the quantum (counted in `splitQuanta`); none is stamped at music rates (§11 point 2). Due ops apply before the voice renders their sample, in frame order, and a due op at the voice's start frame applies before its first sample (so a fade-in with `from 0` never plays a sample at full gain).

**Fade shapes** (`FADE` curve): `linear`; `sCurve` is `p*p*(3-2p)`; `equalPower` rises as `sin(p*pi/2)` and falls as `cos(p*pi/2)` from a 1,024-point table with linear interpolation (error 3.6e-7, the table of spike S4), power-complementary for a crossfade. Never `libm` `sinf` or `sqrtf` per sample (spike S4: 4.5x slower in wasm). A shaped ramp lives in the voice's Timed entry, which overrides `slot.fade` while it runs.

### 3.2 Main tables

| Table | Fields | Writer |
|---|---|---|
| Voice table additions (`voiceTable.ts`) | `musicGroup u16`, `stamped[<=4]` (frame, kind, args: the un-fired stamped ops, for REPLAY) | main |
| `MusicPlayer` (per music instance) | state, `root` runtime node, current `SegmentRun`, next `PlannedStart`, `GridAnchor`, pending `Transition`, playlist cursors and shuffle bags, stinger queue and `dontRepeat` stamps, `subscribed` mask | main, sys |
| `SegmentRun` | node id, anchor, `StemRun[]` (track, picked alternative, clip, voice, streamed, ring primed), loops done, region state, group id | main |
| `GridAnchor` | integer ticks from the segment's bar 1 beat 1 **plus** the heard time it is at, never raw audio frames: a context rebuild at a new rate recomputes frames through `ClockMap` | main |
| `PrimeJob` and estimator | group id, stream ids, requested time, primed set from STATUS, `primeEmaMs` (page-wide) | main, status |
| `RuleIndex` (per container, cached per asset) | pair-to-winning-rule table built lazily, tier recorded | main |

The group id comes from a counter over 1..4095 that skips live ids. A group is one display frame's batch; `commandWriter` keeps a group's records in one BATCH (a group never straddles two).

## 4. Binary formats

One schema (`audio-wire/src/schema/*.rs`, a new `music.rs` added to `SCHEMA_SOURCES`), generated into Rust and TypeScript by `gen_wire` (`npm run build:audio`); the schema hash covers the new file. Record head 12 B as 0157.

### 4.1 PLAY: the gate

The `reserved` u16 at offset 22 becomes `gate`: bits 0-11 `groupId` (1..4095; 0 = ungated), bits 12-15 `groupSize - 1` (groups of 1..16 voices, decoded and streamed members alike). All members arrive in one BATCH with the same `frameOffset`. PLAY stays 56 B and a stamped PLAY already starts at its sample inside its voice (it writes its slot at once and never enters the pending queue, `scheduler.rs:38`, `:57`; the voice starts at its offset in `render_range`, `voices.rs:380-394`; §11 point 1). The gate's behaviour is the architect's S2.

### 4.2 FADE and the timed ops

FADE grows to **28 B**: `from f32` appended at offset 24; `flags` gains bit 1 `hasFrom` (start at `from` instead of the voice's current fade value) and bits 2-3 `curve` (0 linear, 1 sCurve, 2 equalPower); bit 0 `stopAtEnd` as before. A crossfade is a stamped FADE `from 0 -> 1` on each incoming stem and a stamped FADE `-> 0 stopAtEnd` on each outgoing one, same frame, both equalPower. STOP and SET_PARAMS keep their layouts (SET_PARAMS gain and pitch ramps stay linear). Envelope version **1.2** (appended words are minor). No new opcode.

### 4.3 STREAM_OPEN

`flags` gains bit 1 `music`: the ring comes from the music pool; none free is refused, never falls back to a general ring, and is reported as stream event **4** (`musicFull`). Body size unchanged (40 B).

### 4.4 STATUS growth

Header 144 to **168 B** (`HEADER_BYTES`; sections move up 24 B):

| Off | Type | Field |
|---|---|---|
| 144 | u16 | `primedCount` (the `primed` section's count, <= 16) |
| 146 | u16 | `groupStartCount` (<= 16) |
| 148 | u16 | `musicRingsOpen` |
| 150 | u16 | `streamStartsLate` (voices that started after their stamp because of the gate; cumulative, saturating) |
| 152 | u16 | `groupsLate` (cumulative, saturating) |
| 154 | u16 | `timedOverflow` (cumulative, saturating) |
| 156 | u32 | `maxSlipFrames` (largest slip since init) |
| 160 | u32 | `splitQuanta` (quanta the pending queue split, cumulative) |
| 164 | u32 | reserved |

New sections after `zoneEvents`: `primed {u32 streamId}[primedCount]`, the music rings whose buffered frames are >= `START_FRAMES` (4,096) or whose input has ended, **a level reported every STATUS** (so a lost report is repaired by the next); `groupStarts {u32 voiceId; u32 slipFrames; u32 startFrameLo; u32 startFrameHi}[groupStartCount]` (16 B, <= 16 per STATUS, the rest carry over like `starved`), one item per member of a group that started after its stamp, with its exact start frame. Stream event 4 as §4.3. Worst case: 15,904 - 144 + 168 + 64 + 256 = **16,248 B** of 16,384 (136 B spare; contract S5). The `primed` bit is ring state seen by the worklet, not a worker message (revision 2, item 2). Main reads it every STATUS; the architect's S1 fixes the deadline.

### 4.5 Init, ABI, constants

`myco_audio_init(sample_rate, max_logical, max_mixed, max_buses, arena_initial_bytes, max_beds, max_zone_slots, zone_max_frames, max_wide, max_music_rings) -> i32`: a signature change, so **ABI 3.0 (0x300)** as 0162's R6 did for 2.0; `max_music_rings` 0..16 is validated (`InitError::MusicRings`), sizes the `Streams` region (`(G + M) x RING_BYTES`) and the `Timed` region is always laid out. Decoder ABI stays 0x102 (the worker's breadth-first prime is TypeScript). `gen_wire` emits `MAX_MUSIC_RINGS` 16, `MAX_GROUPS` 8, `MAX_GROUP_MEMBERS` 16, `TIMED_ENTRIES` 255, `TIMED_OPS` 4, `PLAY_GATE_ID_MASK`, `PLAY_GATE_SIZE_SHIFT`, `STREAM_OPEN_FLAG_MUSIC`, `FADE_FLAG_HAS_FROM`, the curve values, `STREAM_EVENT_MUSIC_FULL`, `FADE_CURVE_TABLE_POINTS` 1,024, `HEADER_BYTES` 168 and the packers and readers. `vectors/wire.json` gains a golden record for the longer FADE, a gated PLAY and a STATUS with both sections; the fuzz adds a truncated FADE, a gate with size 16 and id 4095, a STATUS with 16 `groupStarts`. The architect quotes constants by name (S11).

## 5. Native layout

| Where | New | Changed |
|---|---|---|
| `audio-wire/src/schema/` | `music.rs` (gate, FADE fields, flags, STATUS fields and sections, constants) | `batch.rs`, `envelope.rs`, `status.rs`, `schema.rs` |
| `audio-core/src/` | `timed.rs` (table, routing, due-op application, shaped ramps), `groups.rs` (table, gate decision, slip report) | `scheduler.rs` (route stamped STOP, FADE, SET_PARAMS), `voices.rs` (in-voice split loop for clip and stream voices; gate in the SCHEDULED branch), `stream.rs` (pools, `primed`, `music` flag), `params.rs`, `layout.rs` (`Timed` before `Arena`), `status.rs`, `counters.rs`, `core.rs` |
| `audio-dsp/src/` | an `equal_power` table next to `ramp.rs`: a checked-in 1,024-point constant generated by a tool and verified by a test (no `sin` in a const context) | `ramp.rs` (a shaped ramp) |
| `audio-wasm` | init signature | exports |

**Size:** mixer 265,952 B after M3 against the 320 KB tripwire (build log D25), warning at 300 KB. Estimate +14 KB (timed ops and shaped ramps +9, groups +4, pools +1; before `wasm-opt`) to about 280 KB; the senior RFC's target of +8 KB is not met and I raise it here (CLAUDE.md: a tripwire, record why). The metered gate (`check:audio-metered`) gains the Z5 and Bench1 scenes at 10%.

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
**Frame order** (header of `audioSystem.ts` gains step 0): `engine.AudioMusic` (update phase, before `engine.UpdateScripts`) calls `backend.beginFrame()` (idempotent per frame: `ClockMap.beginFrame` does nothing the second time at the same `rafTime`), reads the status mirror, dispatches beat messages. `engine.Audio` (lateUpdate) runs 1-8 as in M3, then a new **9. music plan** (`planner`, commits groups, stingers and quantised ramps into the batch) before `frameCommit`. Plugin boundary (`plugins.test.ts`): the audio plugin imports nothing from other plugins; `musicTypes.ts` lives in the engine so `Component.ts` can name `MusicEvent`.

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
| Unit (cargo) | timed table (route, overflow, order, a due op at the start frame, `from` fades, shape endpoints, equal-power power sum within 1e-6), group gate (every S2 row), ring pools, init validation, wire round trips and fuzz |
| Golden (Node, real wasm) | M1-M3 digests unchanged; stamped fades exact to the sample; each seam (cut, three crossfade curves, bridge, loop exit with tail) null against an offline reference to 1e-5; the spike's 1,408-case alignment harness as a test; late-group alignment |
| Pure TS | format parse (every limit and message), writer round trip, grid maths properties, rule precedence and nested containers, calibration on the spike's simulated taps, validation on fixture clips |
| Loopback (fake backend) | planner re-plan on a late worker, pool refusal, rebuild reopening a group, hidden tab, hot reload, switch race, beat clock on recorded jitter traces with a fake `ClockMap` (no wall-clock waits) |
| Babylon | each §8 row against the mocks |
| Bench, metered | Z5 and Bench1 scenes (typical, transition, worst; decoded and streamed), STATUS worst case, `mus-split`-style regression at 10% |
| Playwright (wave end) | a sample plays on the grid with the panel's late-group counter at 0; a switch lands on the bar; stinger; segment view draw, drag, undo; rules table; import; calibration |
| Listening pass (owner) | seams, crossfade curves, stinger timing, beat-callback feel, per milestone, headphones |

**Exit checks:** **M4-0** a stamped fade on one voice among 256 leaves the others bit-identical and no quantum splits. **M4a** 8 stems start within one frame of the stamp; a late ring delays all equally; a playlist runs 10 minutes with no late group. **M4b** every seam null; pool-full keeps the music; a stinger lands on its beat. **M4c** callbacks within 1-2 display frames on the trace set; calibration p95 < 10 ms on simulated taps. **M4d** a composer imports eight stems, sets tempo, places cues, builds one rule and auditions it.


## 10. Task breakdown

Level S (senior), M (mid), J (junior). Days are focused human effort, not agent days. **Critical path in bold.** Every task is at most 5 days. Each task's acceptance is the **per-task cadence** of §9 (typecheck, the affected unit tests, `cargo test` of the touched crate, the committed wasm matching its hash); a row that names a golden, bench or spec is satisfied by the wave-end or milestone-end run. Milestones are shippable in order; M4a's pure-TypeScript tasks (F1a, F1b, F3, G1) and the editor's Ed1 have no dependency on M4-0 and may start with it.

### M4-0 in-voice stamped records (25.5 days, 5.1 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| Z1 | Wire: FADE `from` and curve flags, STATUS header to 168 B with every M4 counter and the empty `primed` and `groupStarts` sections, envelope 1.2 | `audio-wire` schema, `wire.generated.ts`, vectors | - | M | 3.5 | round trip and fuzz of the longer FADE; STATUS worst case 16,248 B; stale wasm fails `npm test` |
| **Z2a** | **Core timed table: `Timed` region, slot link byte, routing of stamped STOP, FADE and SET_PARAMS (gain, pitch), overflow to the queue, RESET** | `audio-core` `timed.rs`, `scheduler.rs`, `layout.rs` | **Z1** | S | 4 | every other stamped record still queues; `timedOverflow` counts |
| **Z2b** | **Core render: due ops applied inside the voice (clip and stream, AUTO and plain), shaped ramps (linear, S polynomial, 1,024-point equal power), `from` fades** | `voices.rs`, `timed.rs`, `audio-dsp` `ramp.rs` | **Z2a** | S | 5 | a stamped FADE moves only its voice; unstamped work bit-identical |
| **Z3** | **Goldens: every M1-M3 digest unchanged; stamped cases re-recorded; exact fade start, power-complementary crossfade, stamped STOP; native equals wasm** | `audio-core/tests`, `golden/` | **Z2b** | S | 4.5 | parity digests identical; new goldens null against the offline reference |
| Z4 | Main: `commandWriter` fade with `from` and curve, voice-table log of un-fired stamped ops, replay re-stamp, status reader, debug rows | `core/commandWriter.ts`, `voiceTable.ts`, `replay.ts`, `statusReader.ts` | Z1 | M | 4 | a REPLAY restores a pending fade at its frame |
| Z5 | Metered scenes for in-voice fades against the queue, baselines, mixer size check | `audio-bench`, `tools/audio-bench` | Z2b | M | 3 | `check:audio-metered` within 10%; mixer growth under 10 KB |
| Z6 | Docs: ADR 0157 amendment text, `implementation-status.md`, guide note on fades | `docs/*` | Z3 | J | 1.5 | `check:links` clean |

### M4a grid, segments, playlists, stems (101.5 days, 20.3 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| F1a | Format: positions, tempo map, cues, regions, tracks with alternatives, `segment` node, ids, limits | `engine/audio/musicFormat.ts`, `musicPosition.ts` | - | M | 4.5 | every §2.3 limit and message; writer round trip |
| F1b | Format: `playlist` and `musicSwitch`, `eventFormat.ts` integration (`NODE_TYPES`, `eventNodes`, `eventClips`, writer, placement rules) | `eventFormat.ts`, `musicFormat.ts` | F1a | M | 3 | `eventClips` lists tracks, alternatives and library clips |
| F3 | `validateMusic`: stem length, rate and channels, gapless, stream-or-decode rule, ring need against the preset, tail longer than loop | `engine/audio/musicValidate.ts` | F1a | M | 3.5 | each lint row of §2.6 on fixture clips |
| G1 | Grid maths: tempo-map compile, position, ticks, seconds and frames, next beat, bar or grid, cue lookup, metre changes | `engine/audio/musicGrid.ts` | F1a | J | 5 | property tests against a naive integrator at 44.1, 48, 96 kHz |
| **W1** | **Wire: PLAY `gate`, STREAM_OPEN `music`, init `max_music_rings` (ABI 3.0), constants, vectors, fuzz** | `audio-wire` `music.rs` (new), schema files | Z1 | M | 4 | round trip and fuzz of the gate field; hash test |
| **C1** | **Core music ring pool: `InitParams`, layout, `StreamStore` pools, refusal event 4, `primed` list, `musicRingsOpen`** | `stream.rs`, `params.rs`, `layout.rs`, `status.rs` | **W1** | S | 4.5 | music and general streams never take each other's rings |
| **C2a** | **Core group table and gate decision (membership, completeness, readiness, late alignment)** | `audio-core` `groups.rs` | **W1** | S | 5 | state-machine tests for every row of S2 |
| **C2b** | **Core gate in `render_range`: ring binding, start at the stamp or the first ready quantum, slip counters, `groupStarts`, member STOP, RESET** | `voices.rs`, `groups.rs`, `counters.rs` | **C2a**, C1 | S | 4.5 | 8 stems start on one frame; a slow ring delays all equally |
| **C3** | **Gate goldens: the spike's 1,408-case alignment harness as a test, late-group null tests, mixed decoded and streamed groups** | `audio-core/tests`, `golden/` | **C2b** | S | 5 | null against the reference after a late start |
| **D1a** | **Worker: group open and breadth-first prime (each stem's first 4,096 frames before any ring fills further)** | `decoder/streams.ts`, `protocol.ts` | W1 | S | 4 | 8 stems primed inside the budget of S1 in the worker test |
| D1b | Worker: cancel on re-plan, close frees the encoded copy, protocol types, fake-decoder support | `decoder/*`, `fakeDecoder.ts` | D1a | M | 3 | worker memory returns to baseline after a cancel |
| **P1** | **`SegmentRun`: stems (alternatives, decoded or stream, group id), `PrimeJob`, one batch per group, pool accounting** | `runtime/music/segmentRun.ts` | **W1**, G1, F1b | S | 5 | loopback: a segment starts on its planned frame |
| **P2** | **Planner: lead, grid-point choice, deadline test, re-plan, pool refusal, one warning per cause** | `runtime/music/planner.ts` | **P1**, D1b | S | 4 | late prime re-plans; refusal keeps the music |
| **P3** | **Counted loop regions, wrap prediction, per-pass alternative hand-over, segment end, grid anchors (musical position plus heard time), rebase on rate change** | `runtime/music/anchors.ts` | **P1** | S | 5 | anchors survive a rate change within 1 frame |
| P4 | Playlist: sequence, random, shuffle, avoidRepeat, `plays`, `rounds`, nesting; natural advance at the exit cue; next always primed | `runtime/music/playlist.ts` | P2, P3 | M | 4 | a long run never shows an unprimed start |
| P5 | Stems: per-stem automation, ring release when silent, solo gain | `runtime/music/stems.ts` | P1 | M | 3 | a silent stem's ring returns at the voice's end |
| P6 | Event runtime: `playNode` for music nodes, `EventInstance.music`, limits, steal, cooldown; `AudioSource` plays music events | `eventRuntime.ts`, `AudioSource.ts` | P1, F1b | M | 5 | 0158 limit tests pass for music events |
| P7 | Public API: `handle.music` (state, `nextGrid`), `Audio.horizon`, `Audio.timeAt`, early `engine.AudioMusic` step and `beginFrame` order, exports | `Audio.ts`, `audioSystem.ts`, `backend.ts`, `myco.ts` | P6 | M | 3.5 | every §1 row tested; `Audio.time` in `update()` is this frame's |
| P8 | Hot reload of a playing segment: re-prime and swap at the next bar | `runtime/music/reload.ts` | P2 | M | 2.5 | a stem edit swaps at the next bar without a gap |
| P9 | Hidden tab (`play` commits a segment ahead, `mute` re-plans on resume) and context rebuild (reopen the group as a group) | `runtime/music/background.ts`, `core/recovery.ts` | P2, P3 | S | 4.5 | rebuild and hidden-tab loopbacks keep stems aligned |
| P10 | `Audio.debug().music`, status reader fields, debug panel rows, one warning per cause | `debug.ts`, `statusReader.ts`, `AudioDebugPanel.tsx` | P2 | M | 3 | each §1.6 counter reaches the panel |
| T1 | Integration tests: late worker, re-plan, refusal, rebuild, hidden tab, hot reload, on a deterministic clock | `music/*.loopback.test.ts` | P9 | M | 5 | all pass without wall-clock waits |
| B1 | Babylon M4a: segments (decoded stamped starts through `waitTime`), playlists, stream warning | `babylonBackend.ts` | P6 | M | 2.5 | §8 rows against the mocks |
| SM1 | Samples: sound-lab `music-intensity` as a segment with stems, flappy `town.mp3` as a streamed segment, presets, a tempo tool | `samples/*`, `tools/` | P6 | M | 3.5 | both load warning-free and play on the grid |
| E1 | Playwright: a sample plays a segment and a playlist; the panel shows no late group | `tests/e2e/audio-music-a.spec.ts` | SM1, P10 | M | 3 | 3 of 3 repeats at wave end |
| D2 | Docs: guide `interactive-music.md` (segments, playlists, stems), status rows | `docs/*` | SM1 | J | 2 | `check:links` clean |

### M4b switches, rules, bridges, stingers (65 days, 13.0 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| F2 | Format: `transitions`, `stingers`, `library`, dangling ids, duplicate and shadow warnings, specificity index, limits | `musicFormat.ts`, `musicRules.ts` | F1b | M | 4 | every §2.4 and §2.5 rule and limit |
| **R1** | **Rule engine: tier and nearest-common-parent lookup, exit and enter times under tempo maps, exit clamp, natural advance, fades in beats** | `runtime/music/transitionRules.ts` | **F2**, G1 | S | 5 | §2.4 precedence tables pass, nested containers included |
| R2 | `musicSwitch`: parameter to child, latest wins, return cancels, continue to play | `runtime/music/musicSwitch.ts` | R1 | M | 3 | two changes inside one bar land once |
| **R3a** | **Transition execution: incoming group stamped at exit minus pre-entry, outgoing faded in the voice, post-exit tail under the next segment, ring accounting for two sets** | `runtime/music/transition.ts` | **R1**, P2, Z2b | S | 5 | cut and crossfade seams sample-exact |
| **R3b** | **Bridges: A to bridge to B, per-leg fades, ring accounting for three sets, degrade when the pool cannot hold them** | `runtime/music/transition.ts` | **R3a** | S | 5 | a bridge seam is exact; pool-full keeps A and warns |
| R4a | Loop tails: extra tail voices mixed over the loop start (decoded, or a short-lived ring); tail refusal | `runtime/music/loopTail.ts` | R3a | S | 4 | a tail rings over the wrap and frees its ring |
| R4b | `while` regions: condition read one lead before the loop end, released through the region-release splice | `runtime/music/regions.ts` | P3, R3a | S | 4 | a flag set after the commit waits one more pass (stated latency) |
| R5 | Stingers: trigger namespace, quantise, `dontRepeat`, `ifTooLate`, own bus, `handle.trigger` | `runtime/music/stingers.ts` | R1, P6 | M | 5 | each `ifTooLate` branch; a stinger never changes the grid |
| R6 | `quantize` (`beat` or `bar`) on automation bindings (stamped in-voice ramp at the next grid point) | `music/stems.ts`, `events/automation.ts` | R1, Z4 | M | 2.5 | a bound stem enters on the bar line, sample-exact |
| **T2** | **Seam goldens: cut, three crossfade curves, bridge, loop exit with tail, against an offline reference** | `golden/`, `music/seam.test.ts` | R3b, R4a | S | 5 | each seam nulls to 1e-5 |
| T3 | Rule, precedence and nested-container tests; transition loopbacks (late prime, pool full, switch race) | `music/*.test.ts` | R3b | M | 5 | all pass without wall-clock waits |
| P11 | Debug: matched rule and tier, pending transition, planned grid point, refusals | `debug.ts`, `AudioDebugPanel.tsx` | R3a | M | 2 | panel rows against the loopback host |
| Bench1 | Metered music scenes (typical, transition, worst; decoded and streamed; group start), STATUS worst-case test | `audio-bench`, `tools/audio-bench` | R3b | M | 4 | within the allowance of S7; baselines recorded |
| B2 | Babylon M4b: switches at bar boundaries, stingers on decoded clips | `babylonBackend.ts` | R5 | M | 2.5 | §8 rows against the mocks |
| SM2 | Samples: `makeMusic.mjs` stems, sound-lab music scene (explore and combat, a bridge, a stinger, intensity) | `samples/sound-lab`, `tools/` | R5 | M | 4 | scene loads warning-free; every rule audible |
| E2 | Playwright: a switch change lands on the bar; a stinger fires; the debug rule row | `tests/e2e/audio-music-b.spec.ts` | SM2 | M | 3 | 3 of 3 repeats at wave end |
| D3 | Docs: guide chapters on transitions, bridges, stingers | `docs/guide` | SM2 | J | 2 | `check:links` clean |

### M4c beat callbacks and rhythm mode (35.5 days, 7.1 person-weeks)

| ID | Task | Files | Depends | Lvl | d | Acceptance |
|---|---|---|---|---|---|---|
| **K1** | **Beat clock (design A): prediction from tempo map, anchors and `ClockMap`, window firing, `missed` coalescing, corrections from `groupStarts` and playheads** | `runtime/music/beatClock.ts` | P3, R3a | S | 5 | S4 tolerances on recorded jitter traces |
| **K2** | **`engine.AudioMusic` dispatch, component messages, subscription mask, hook types** | `music/musicSystem.ts`, `engine/core/Component.ts` | **K1** | M | 3.5 | messages arrive before `update`; no cost without subscribers |
| K3 | `positionAt`, `judged`, `Audio.timeAt` finalised, event types, exports | `music/handle.ts`, `Audio.ts`, `myco.ts` | K1 | M | 2.5 | every §1 row tested |
| K4 | Deterministic beat-clock tests: fake `ClockMap`, jitter traces, tempo change, seek, hidden-tab gap | `music/beatClock.test.ts` | K1 | M | 4 | 0 missed, doubled or phantom over the spike's traces |
| Rh1 | `audio.rhythmMode`: numeric `latencyHint`, latency read-back, `Audio.latency`, stamped-only music changes | `core/context.ts`, `settings.ts`, `Audio.ts` | K1 | S | 5 | toggles through the rebuild path; an asap music change is refused with one warning |
| Rh2 | `Calibration.fromTaps`, `Audio.calibration`, persistence through `Storage` per output device, re-ask on device change | `music/calibration.ts` | K3 | J | 4 | p95 error under 10 ms on the spike's simulated taps |
| Rh3 | Calibration and tap-game sample scene | `samples/sound-lab` | Rh2 | M | 4 | the offset persists across a reload |
| B3 | Babylon M4c: callbacks from the main-side clock, rhythm-mode warning | `babylonBackend.ts` | K2 | M | 2 | §8 rows against the mocks |
| E3 | Playwright and loopback: callbacks reach a script; the calibration flow | `tests/e2e/audio-music-c.spec.ts` | Rh3, K2 | M | 3.5 | 3 of 3 repeats at wave end |
| D4 | Docs: guide chapter on callbacks and rhythm mode | `docs/guide` | Rh3 | J | 2 | `check:links` clean |

### M4d editor, samples, listening pass (63.5 days, 12.7 person-weeks)

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
| Ed10 | Project Settings > Audio: music rings and rhythm mode with the preset; debug monitor polish | `AudioSettingsSection.tsx`, `audioSettingsModel.ts` | W1, Rh1 | M | 3 | edits persist; preset comparison includes `musicRings` |
| Ed11 | Playwright: segment view, rules table, import, settings | `tests/e2e/audio-music-d.spec.ts` | Ed3, Ed7, Ed9 | M | 5 | 3 of 3 repeats at milestone end |
| L1 | Listening-pass document, scenes, lab-VM and phone instructions | `listening-pass.md` | SM2, Rh3 | J | 2.5 | every owner item has a key or scene |
| L2 | Samples final: flappy music in play, sound-lab scene polish, `implementation-status.md` | `samples/*`, `docs` | L1 | M | 3 | samples warning-free and non-silent |
| L3 | Listening-pass rework: seams, curves, stinger timing, beat feel (the owner's items) | as the items say | L1 | S | 5 | owner sign-off block filled |
| D5 | Docs: API reference, ADR amendments 0158 and 0097, guide final | `docs/*` | L2 | J | 3 | `check:links` clean |

### 10.1 Total, reserve and the critical path

Tasks, summed by script from the rows: M4-0 25.5 + M4a 101.5 + M4b 65 + M4c 35.5 + M4d 63.5 = **291 days** (58.2 person-weeks at 5 d). By level: S 98 d, M 166.5 d, J 26.5 d. **Named reserve 96 days** (about a third of the tasks, the skill's calibration):

| ID | What the reserve is for | d |
|---|---|---|
| RS1 | Listening-pass rework beyond L3: seams, curve laws, stinger timing, beat feel | 12 |
| RS2 | Real-device beat clock, `outputLatency` honesty and the phone prime lead (the lab VM and phone runs are the owner's) | 14 |
| RS3 | Group-gate corner cases: rebuild, 44.1/48 kHz, virtual members, seek during a wait, worker crash mid-prime | 10 |
| RS4 | In-voice hot path over its gates: wasm size and speed, `wasm-opt`, metered baseline moves | 8 |
| RS5 | Editor rework after a composer trial: drag, zoom, snap, undo, waveform speed for 8 long stems | 14 |
| RS6 | Babylon surprises: HTML5 streamed stems, browser quirks | 6 |
| RS7 | WebKit and Firefox at milestone ends: AudioWorklet and latency quirks | 10 |
| RS8 | Wave-end integration: flakes, merges in `eventRuntime.ts` and `voices.rs`, e2e repeats | 12 |
| RS9 | Format gaps from real DAW bounces: MP3 padding, odd rates, tails | 6 |
| RS10 | Worker memory on low: shared encoded copies if 8 stems hold too much | 4 |

**Total 387 days, 77.4 person-weeks** (tasks 58.2, reserve 19.2). The critical chain is about 112 days (Z1-Z3 16.5, F1a-G1-P1-P3-P9-T1-E1 about 32, F2-R1-R3a-R3b-T2 24, K1-K3-Rh2-Rh3-E3 19, Ed1-Ed3-Ed11 about 20): roughly 22 weeks if nothing waits, about 30 with the reserve drawn in proportion. Seniors carry 98 days of table work (the core tasks, the planner, the rules and the beat clock), so **two seniors are the floor** and the three S chains (core, player, clock) should not share one person.

### 10.2 Line by line against the record's provisional estimate

The record (revision 2) priced 24.5 person-weeks of features and called the whole **45-55**. Mapping my rows onto its lines:

| Record line | Record pw | My rows | d | pw | Why it differs |
|---|---|---|---|---|---|
| Format and validation | 1.5 | F1a, F1b, F3, F2 | 15 | 3.0 | ids, limits, rules, stingers, library and the two-tier clip-fact lint were not itemised |
| Grid maths | 1 | G1 | 5 | 1.0 | as priced |
| Main-side player, rules, stingers, planner | 4 | P1-P6, P8-P11, R1-R6 | 71.5 | 14.3 | the record priced about twice M3's zone planner (C5, 8.5 d); the table has the prime and commit state machine, loop and anchor prediction with rate rebase, nested playlists, hot reload, hidden tab and rebuild, `musicSwitch`, transitions with pre-entry, tails and bridges, `while`, loop tails, stingers, quantised ramps, debug rows |
| Streams: prime protocol, pool, slip counter | 2.5 | W1, C1, C2a, C2b, D1a, D1b | 25 | 5.0 | the group gate (a core state machine, S2) replaced the slip counter, and the worker needs a group open, breadth-first prime and cancel |
| In-voice ramps | 1.5 | Z1, Z2a, Z2b, Z4 | 16.5 | 3.3 | a table, routing, a render change on both voice paths, shaped ramps and REPLAY |
| Beat clock and API | 1.5 | P7, K1, K2, K3 | 14.5 | 2.9 | includes the early frame step and component dispatch |
| Rhythm mode and its sample | 2 | Rh1, Rh2, Rh3 | 13 | 2.6 | close |
| Fallback | 1 | B1, B2, B3 | 7 | 1.4 | as priced, spread over three milestones |
| Editor | 7.5 | Ed1-Ed8, Ed10 | 40.5 | 8.1 | waveform peaks, tempo-aware snapping, undo and preview through the backend were the senior RFC's 2 pw; the record's 7.5 held none of them |
| Import hints | 0.5 | Ed9 | 4.5 | 0.9 | a RIFF reader and lint rows |
| Samples and listening pass | 1.5 | SM1, SM2, L1, L2, L3 | 18 | 3.6 | two sample sets and a rhythm scene plus one rework row |
| Not in the record (the senior RFC's about 12 pw) | 12 | Z3, Z5, C3, T1-T3, K4, Bench1, E1-E3, Ed11, D2-D5, Z6 | 60.5 | 12.1 | goldens and replay, benches, tests, e2e, docs; it matches the RFC's figure |
| **Tasks** | **24.5 (+12)** | | **291** | **58.2** | |
| Reserve (about a third) | in the multiplier | RS1-RS10 | 96 | 19.2 | |
| **Total** | **45-55** | | **387** | **77.4** | **22.4 pw over the top of the record's range** |

**The honest reading.** The record's 45-55 holds if the reserve is dropped and the player is priced near its 4 pw; the table does not support either. Without the reserve the tasks are 58.2 pw, 3.2 over the range's top; the player alone is 14.3 pw against the record's 4, and the wire, gate, worker and ramp work is 8.3 against 4. I keep the reserve at a third because M3's build showed the pattern (zone cost 1.45x its model, a zone-port bug that only the e2e spec found, a mixer gate that needed an owner move); M3 drew none of its 14 days, so the reserve is the part the owner can most defensibly challenge.

**Calibration from M3** (`build-log.md`, which logs agent time, not human days): M3's table days against per-kind work, which these rows copy: wire A1 5 d for five records and STATUS (Z1 3.5 and W1 4 carry fewer), core bed A4 7, zones C3 9, ambisonic voice B3 6 (Z2a and Z2b 9, C2a and C2b 9.5, C1 4.5), goldens and benches A7 4.5, C7 4.75, D6 3.75 (Z3 4.5, C3 5, T2 5, Z5 3, Bench1 4), editor E1 4, E3 5.5, E4 4 (Ed rows 4 to 5), e2e E9 4 (E1 to E3 3 to 3.5, Ed11 5), samples E8 6.5, listening E10 2 (SM1, SM2, Rh3, L2, L1). M3's own lessons are in: a leaf with an unmeasured bound stays with its lead (the gate's late-start and the prime budget are measured first, S1 and S2), e2e catches wiring bugs unit tests miss, and the metered gate and mixer size are checked per task.

**Not taken, owner's choice** (each cuts scope or moves schedule, so I list them and do not decide): (a) fold M4-0 into M4b as shaped FADEs through the queue, one split per transition, about 0.5 ms once: saves about 11 days (Z2a, half of Z2b, half of Z3, Z5); see §11 point 1; (b) drop `while` regions and loop tails (R4a, R4b, 8 d); (c) ship the rules table without audition and lint (about 4 d); (d) drop the rhythm sample scene (Rh3, 4 d); (e) drop the Babylon beat callbacks (B3, 2 d). All five: about 29 days, 5.8 pw.

## 11. Where the record is wrong or under-specified

Anything here that changes behaviour, scope or schedule goes to the owner through the coordinator; I have taken the cheapest reading in this document and say which.

1. **A stamped PLAY does not split the quantum; revision 2's correction is right only for the other records.** `scheduler.rs:38` and `:57`: PLAY "writes its slot at once with that start frame", and `PendingRecord` is "STOP, SET_PARAMS, FADE and SET_PAUSED only (PLAY is written to its slot at once)"; `voices::play` sets the slot `SCHEDULED` and `render_range` starts it at its offset (`voices.rs:380-394`) without cutting the quantum. Only the records that go through `pop_due` (`voices.rs:310-325`) split. So spike S4 was right about PLAY, and the senior RFC's issue 7 was right that STOP splits. After this a transition today costs one split (A's STOP), not two. Consequence for M4-0: its real content is STOP, FADE and SET_PARAMS gain and pitch (§3.1), plus the shaped fade curves, which music needs anyway. **Owner decision (not taken here):** M4-0 as a separate first milestone fixes a cost only music pays, because nothing else stamps fades, which is the challenger's point; the cheaper reading is to fold the curved FADE into M4b and send it through the queue (one split, about 0.5 ms, once per transition), saving about 11 days (§10.2).
2. **"Every stamped record that touches one voice" is narrowed to STOP, FADE and SET_PARAMS gain and pitch.** `dir`, `lpHz`, `score`, `bus`, `flags`, SET_PAUSED, SEEK and SET_LOOP stay queued and split; none is stamped at music rates, and `splitQuanta` makes a regression visible. Widening it is a per-field task.
3. **The voice slot has no room for a pending ramp.** `VoiceSlot` fills `VOICE_SLOT_BYTES` (192 B) by my count of its fields (`voices.rs:124-166`; the assert at `:167` is `<=`, so the first task to touch it confirms), so "the voice carries the ramp" is a side table (Timed, §3.1) plus a one-byte link in the slot's `reserved`. Growing the slot to 256 B instead costs 256 KB on default and high.
4. **ABI is 3.0, not 2.1** (the init signature changes, as 0162 R6 did for 2.0); the envelope is 1.2. STATUS has 136 B spare after this (16,248 of 16,384): the next growth needs the shell's `STATUS_BUFFER_BYTES` raised.
5. **Exit, pre-entry and post-exit were left loose.** I define: a rule's `exit` is clamped to the exit cue when it would fall after it; pre-entry applies only to `enter: "entryCue"`; a natural playlist advance ignores the rule's `exit` and leaves at the exit cue (§2.4). The first is Wwise's reading of "exit source at"; the last two are mine.
6. **Direct `Audio.play` callers get no beat callbacks.** The record routes callbacks to components on the `AudioSource` node; a script that plays an event itself has no node. Cheapest: poll `handle.music`. Recommended small addition (0.5 d, M4c): `handle.onMusic(kind, fn)` returning an unsubscribe. Owner call.
7. **`while` has no condition vocabulary to reuse** (the format has curves and parameter names, no conditions). I defined `is`, `atLeast`, `below` (§2.3).
8. **Names the record left open.** Loop counts are `plays` (per item) and `rounds` (list), not `loop`, which is a boolean on `clip` and `sequence`; bridge and stinger segments live in a container's `library`; rule `from` and `to` name direct children (Wwise's nearest-common-parent scheme needs nothing deeper); the debug row names are §1.6.
9. **Pool arithmetic bounds what a preset can do.** 8 / 12 / 16 rings hold two sets of 4 stems on low with no bridge, two sets of 4 plus a bridge of 4 on default, two sets of 6 plus a 4-stem bridge on high. Loop tails, a streamed stinger, hot reload (the reloaded segment primes beside the playing one) and per-pass alternatives on a streamed stem (a primed hand-over at each wrap, because a loop cannot jump into a different file) each need extra rings. The lint says "needs N rings, this preset has M". Decoded stems and short loops are the lever; a larger low pool is the owner's, not reopened here.
10. **"Rings return as soon as the core reports the voice's end"** is a one-STATUS lag for main's accounting (up to 16 ms plus a message): a plan inside that window can see the pool full and refuse needlessly. S3 asks the architect to state the rule (count rings main has freed, not the last `musicRingsOpen`).
11. **`quantize` on automation cannot be a core binding** (the core evaluates bindings continuously). A bound stem is evaluated on main at the grid point and applied as a stamped 20 ms in-voice ramp, so it does not follow the parameter between grid points (§2.3). Stated so a composer is not surprised.
12. **Mixer size**: +14 KB (est.) against the senior RFC's +8 KB target; the gate is a tripwire (CLAUDE.md), recorded here.
13. **Not specified by the record, taken as stated in §1:** a quantised `stop` (none; `stop(fade)` only, allowed in rhythm mode); `Nothing` as a rule source or target (none; the default rule governs a start); an `Audio.play(music, { at })` too close to prime (starts when primed, warns); stems of one segment must share a file rate, segments need not.
14. **The estimate**: the table is 58.2 person-weeks before the reserve and 77.4 with it, against the record's provisional 45-55 (§10.2). The drivers are the player, the gate and worker, and the editor; the record's own line items hold to within a day or two where it priced them.

