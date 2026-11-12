# Interactive music: API reference

The reference for everything interactive music adds to the scripting API and to the `*.audioevent.json` format. For how the pieces fit together, with worked examples, read [Interactive music](interactive-music.md). The design is ADR 0166 as amended by 0167 (`docs/decisions/`).

Conventions, all of them checked against the code:

- **Times are seconds on the heard clock** (`Audio.time`'s base, the moment a sound is *heard*, output latency included) unless a field says otherwise. A `performance.now()` value (what `event.timeStamp` holds) is in milliseconds and is marked so.
- **Bars and beats are 1-based integers.** A position is the text `"bar:beat:tick"`; a beat has 960 ticks.
- Everything in the scripting part is exported from `"myco"`. The format types and validators (the last part of this page) are engine modules for tools and the editor; a game script writes the JSON and never imports them.

## `Audio`

All members are on the `Audio` object. The first three are read-only.

| Member | Type | Meaning |
| --- | --- | --- |
| `Audio.horizon` | `number` (seconds) | The earliest heard time at which a *stamped start of a decoded clip* is exact: now plus the audio core's lookahead. Not a promise for a streamed clip, which needs priming first. On a backend without it, `Audio.time` |
| `Audio.timeAt(performanceTime)` | `number` (seconds) | The heard time of a `performance.now()` instant in milliseconds, such as `event.timeStamp`. **Raw: calibration is never applied.** Before the clock has an estimate it returns `Audio.time` |
| `Audio.latency` | `AudioLatency` | A new object per read, see [below](#audiolatency). Zeros and not `reliable` on the Babylon fallback |
| `Audio.calibration` | `number` (seconds), read and write | Default 0. What `positionAt` subtracts: `judged = offset - Audio.calibration`. Setting it saves it for the current output device (`Storage`, namespace `settings`, key `audio.calibration.<sink id>`, `.default` for the default device) and clears `calibrationStale`. A non-finite value is ignored. Loaded again when the context starts (not on the Babylon fallback, where it lasts for the session) |
| `Audio.calibrationStale` | `boolean` | True after the output device changed, until `Audio.calibration` is set again. If the new device was calibrated before, its saved value is loaded and this stays false; otherwise the old value is kept. Not set on the Babylon fallback |
| `Audio.rhythmMode` | `boolean` | The project's `audio.rhythmMode` setting (default `false`), as the running mixer has it. It reports the setting even where the backend cannot honour it (the Babylon fallback warns once) |

### `Audio.play(event, options?)`

`Audio.play` returns an `AudioEventHandle`. For an event whose `root` is a segment, playlist or musicSwitch, the handle is also a `MusicEventHandle`. `options` is the one for every event (`EventOptions`):

| Option | Meaning |
| --- | --- |
| `parameters` | Initial values of the event's local parameters (labelled ones by label): `{ State: "explore" }` |
| `at` | Seconds, heard time. For music it is when the **entry cue** is heard; the pickup starts earlier. Past, non-finite or omitted, or closer than the player needs to prepare: as soon as possible |
| `volume`, `bus`, `priority` | As for any event |
| `pitch`, `position` | Ignored for music (`pitch` with a warning). A music event is flat |

Nothing is a grid before the first segment starts sounding: that moment becomes bar 1 of the grid.

### `AudioEventHandle` (the music members)

Everything an event handle has (`playing`, `reason`, `stop(fade)`, `fade(to, seconds)`, `setParameter`, `getParameter`, `release()`; [Sound events](sound-events.md)) plus:

| Member | Type | Meaning |
| --- | --- | --- |
| `handle.music` | `MusicHandle \| undefined` | The music state. `undefined` for an event whose root is not music, and again once the instance has ended; never an empty object |
| `handle.onMusic(kind, fn)` | `(kind: MusicKind, fn: (e: MusicEvent) => void) => () => void` | Subscribe to `"beat"`, `"bar"` or `"cue"` events of this instance, for music started with `Audio.play`. Returns an unsubscribe function. A handle that is not music returns a function that does nothing |
| `handle.trigger(name)` | `boolean` | Fire the stinger whose `trigger` is `name`. `true` when accepted. `false` for an unknown name, a stinger dropped by `dontRepeat` or `ifTooLate: "skip"`, one the pool refused (no ring for a streamed stinger), and before the music has started |
| `handle.playing` | `boolean` | True until the instance ends or is stopped |

`handle.stop(fade)` fades all stems at once and is not quantised.

`onMusic` rules: calls come in the same frame and with the same coalescing as the component hooks, after them, in subscription order. The `MusicEvent` is one reused object per kind: copy what you need. A listener removed inside a callback skips from the next event on; one added inside a callback hears the next event. Subscribing the same function twice calls it twice, and each returned function removes one subscription. Listeners are dropped when the music ends. No backlog is replayed to a late subscriber.

### `MusicHandle` (`handle.music`)

Every getter reports where the music is **as it is heard**, not as scheduled. The getters share one snapshot per display frame, so reading them costs nothing.

| Member | Type | Meaning |
| --- | --- | --- |
| `segment` | `string \| null` | Id of the playing segment; `null` while the first one is being prepared (then `bar` and `beat` read 1 and `tempo` 0) |
| `bar`, `beat` | `number` | 1-based position |
| `beatFraction` | `number` | 0 to 1 through the beat |
| `tempo` | `number` | Beats per minute |
| `beatsPerBar` | `number` | |
| `beatUnit` | `number` | The metre's note value (4 in 3/4) |
| `time` | `number` (seconds) | Heard time of that position: this display frame's `Audio.time` |
| `transition` | `{ to: string; time: number } \| null` | The pending change: target child id and the heard time it lands. `null` when none |
| `nextGrid(spec)` | `GridPoint \| null` | The next grid point of that spec, at or after now. While a change is pending, points after `transition.time` belong to the new segment (`GridPoint.segment` says which). `null` when not playing, or when nothing follows the exit |
| `positionAt(performanceTime)` | `MusicPositionAt` | Map an input timestamp (`performance.now()` ms) to the music; see [below](#musicpositionat) |
| `seek(to)` | `MusicSeekResult` | Jump to `"bar:beat:tick"` in the segment playing when the seek lands; see [below](#musicseekresult) |

#### `MusicPositionAt`

`handle.music.positionAt(event.timeStamp)`:

| Field | Type | Meaning |
| --- | --- | --- |
| `segment` | `string \| null` | `null` when the music is not sounding at that instant (the other fields are then 0) |
| `bar`, `beat` | `number` | Where the music was. Before a segment's first bar (its pickup) both read 1 |
| `beatFraction` | `number` | 0 to 1 through the beat |
| `nearestBeatTime` | `number` (seconds) | The nearest beat's heard time. Only a beat that is actually heard is offered: one an upcoming change cuts off is not |
| `offset` | `number` (seconds) | Signed distance to that beat; **positive means the input was late.** Raw, before calibration |
| `judged` | `number` (seconds) | `offset - Audio.calibration`: what a rhythm game compares |

The input is mapped with `Audio.timeAt`, then read on the music's grid, across tempo and metre changes and across a change of segment. The position is kept for the playing segment and its pending successor only: ask about a recent input, not about a time before the last change landed.

#### `MusicSeekResult`

```ts
type MusicSeekResult =
  | { ok: true; time: number }                       // planned heard landing time, seconds
  | { ok: false; reason: "invalid" | "notPlaying" | "neverFits" | "poolFull"; permanent: boolean };
```

| `reason` | `permanent` | Meaning |
| --- | --- | --- |
| `invalid` | true | Not a position, a beat the bar does not have, or no playable track |
| `notPlaying` | true | The music is stopping, stopped or refused. (Before the first segment has started sounding it is temporary: call again on a later frame) |
| `neverFits` | true | The segment can never hold two sets of streaming slots on this preset |
| `poolFull` | false | No free music rings now; call again on a later frame |

`seek` takes `"bar:beat:tick"` (`"5:3"` and `"5"` fill in the rest). It crossfades over 5 ms and lands on the earliest frame the core can stamp, not on a beat. A position past the end goes to the end; one in the pickup enters exactly there; at or past the exit cue the segment plays on from there. A refused seek did not happen, though a pending change it would have replaced is gone. It never moves to another segment, and fires no beats or cues for the span it skips.

### Importable types

Every type in this reference is importable from `"myco"` as a type, so a script can name it in annotations (ADR 0168): the handle and event types (`MusicEventHandle`, `MusicEvent`, `MusicHandle`, `MusicPositionAt`, `MusicSeekResult`, `GridSpec`, `GridPoint`, `MusicKind`, `CalibrationResult`, `CalibrationApi`, `AudioLatency`) and the format's node model (`SegmentNode`, `PlaylistNode`, `MusicSwitchNode`, `MusicNode`, `TempoMarker`, `MusicCue`, `MusicRegion`, `MusicTrack`, `MusicAutomation`, `TransitionRule`, `TransitionFade`, `StingerDef` and their field types). Use `import type`: the exports are types only, so they add nothing to the bundle. Constants, parsers and the writer are not exported.

```ts
import { Component } from "myco";
import type { MusicEvent, MusicEventHandle } from "myco";

class Pulse extends Component {
  private music?: MusicEventHandle;
  onMusicBeat(e: MusicEvent) { this.music = e.handle; }
}
```

### Value types

```ts
type GridSpec = "beat" | "bar" | { every: "beat" | "bar"; n: number };   // n 2..64
type MusicKind = "beat" | "bar" | "cue";

interface GridPoint { time: number; bar: number; beat: number; segment: string }
```

#### `MusicEvent`

What a beat, bar or cue callback carries:

| Field | Meaning |
| --- | --- |
| `handle` | The `AudioEventHandle` that `Audio.play` returned, so `e.handle.music` and `e.handle.trigger(...)` work in a hook |
| `segment` | Id of the playing segment |
| `bar`, `beat` | 1-based; a bar event has `beat` 1 |
| `cue` | Cue events only: the cue's name |
| `tempo`, `beatsPerBar` | At this point |
| `time` | Seconds: when this beat is heard |
| `heardIn` | Seconds until it is heard, `time - Audio.time`. Under one frame, and not negative unless `missed` is above 0 |
| `missed` | Beats of this kind folded into this call after a gap longer than a beat (a stalled frame, a hidden tab, a rhythm-mode rebuild); 0 normally |
| `skippedCues` | Cue events only: the names of cues coalesced away |

#### `AudioLatency`

All seconds. `base` and `output` are the context's `baseLatency` and `outputLatency`; `limiter` is the limiter's look-ahead; `total` is their sum; each part reads 0 if it is not finite or is negative. `reliable` is true only when the backend says the output figure is live **and** 0 < `output` < 0.5, so a constant 0 is never reliable.

#### `CalibrationResult`

| Field | Meaning |
| --- | --- |
| `offset` | The median of the offsets kept (seconds): the player's usual lateness, with the output delay in it |
| `spread` | Their median absolute deviation (seconds), unscaled |
| `confidence` | `clamp01(1 - spread / 0.040) * min(1, used / 16)` |
| `used`, `discarded` | Offsets kept after the warm-up, and offsets dropped (`offsets.length - used`) |
| `steady` | `spread <= 0.040` and `used >= 8` |

### `Calibration.fromTaps(offsets, options?)`

`fromTaps(offsets: readonly number[], options?: { warmup?: number }): CalibrationResult`. `offsets` are raw `positionAt(...).offset` values in seconds. Non-finite values (missed taps) are dropped first, then the first `warmup` of the rest (default 4; a `warmup` that is not a finite number of 0 or more is the default). With nothing left, the result is all zeros and `steady` is false: it never throws. It applies nothing; set `Audio.calibration = result.offset` yourself when `result.steady`.

### Component hooks

On a `GameBehavior`, on the node of the `AudioSource` that plays the music or on that source's owner node. Defining a hook is the subscription.

| Hook | Called |
| --- | --- |
| `onMusicBeat(e: MusicEvent)` | On every beat |
| `onMusicBar(e: MusicEvent)` | On the first beat of every bar (`e.beat` is 1) |
| `onMusicCue(e: MusicEvent)` | When the music reaches a cue; `e.cue` names it |

They run in the update phase just before `update`, in the frame whose window holds the beat's heard time. The same `MusicEvent` object is reused for every call of a kind, and nothing is allocated per beat. A hook defined or enabled mid-play hears only the beats from then on; a disabled behavior is not called and misses are not replayed. A hook that throws is logged and the others still run.

### Debug types

`Audio.debug().music` is a `MusicDebugRow[]` and `Audio.debug().musicTotals` a `MusicDebugTotals`; `MusicDebugState` is `"priming" | "playing" | "transitioning" | "recovering" | "ending"` and `MusicDebugPending` is the waiting change with its rule (`to`, `time` as `"bar:beat"`, `rule` index or -1 for the default, `ruleKey` as `"from>to"`). The columns are described in [the debug panel's Music section](interactive-music.md#the-debug-panels-music-section); the fields are in `src/plugins/audio/runtime/backend.ts`.

## Project settings

In `project.json`, and in Project Settings > Audio > Playback > Music:

| Key | Default | Meaning |
| --- | --- | --- |
| `audio.music.rings` | 12 (presets: low 8, default 12, high 16) | The music ring pool, a whole number 0 to 16; a value outside it is clamped with a problem |
| `audio.rhythmMode` | `false` | Build the audio context with `latencyHint: 0`. A change at run time rebuilds the context (at most once a second) |

## The music format

A music event is an ordinary [sound event](sound-events.md#the-file) (`"format": "myco.audioevent@1"`) whose `root` is a segment, playlist or musicSwitch. The parser is lenient: a bad entry is dropped or clamped and reported as a problem that names its path; it never throws. A problem that begins with `error: ` is an error (a `pitch` automation on a stem); the rest are warnings.

Every music node needs `id`, `^[A-Za-z0-9_-]{1,48}$`, unique in the event (library segments included). A music node may sit only under a music container (or be the root), and a sound-event node (`clip`, `layer`...) may not sit under one.

Common to all three nodes: `volume` (0 to 4, default 1), `volumeRandom`, `weight` (default 1, for a playlist in `random` mode), `value` (the label a `musicSwitch` matches), `plays` (default 1, 1 to 64, as a playlist child). `pitch`, `pitchRandom`, `delay`, `range` and `fade` are read and ignored, one problem each.

### `segment`

| Field | Default | Meaning |
| --- | --- | --- |
| `gridOffset` | 0 | Seconds (0 to 3600) of audio before bar 1, beat 1 |
| `tempo` | one marker, 120 bpm, 4/4 | 1 to 64 `TempoMarker`s, strictly increasing, the first at `"1:1:0"` |
| `cues` | none | Up to 64 `{ name, at }`, unique names; `at` is `"bar:beat:tick"`, `"start"` or `"end"` |
| `entry`, `exit` | the cue named `entry` / `exit` if there is one, else the grid start (`1:1:0`) / the end of the audio | Names of the entry and exit cues |
| `regions` | none | Up to 16 loop regions, played in file order |
| `tracks` | none | 1 to 16 stems. A segment with none plays nothing and is reported |

`TempoMarker`: `{ at: "bar:beat:tick" (tick 0), bpm (1 to 1000), beatsPerBar (1 to 32), beatUnit (1, 2, 4, 8 or 16) }`. A marker sits on a beat; a change of metre that is not on beat 1 moves to the next bar, with a problem.

`Region`: `{ id, from ("bar:beat:tick" or "start"), to ("bar:beat:tick" or "end", after from), count, tailBeats?, while? }`. `count` 0 (default) is forever, 1 is one pass and no loop, 2 to 64 that many passes in all. `tailBeats` is 0 to 16, default none. `while` is `{ parameter, is: string }`, `{ parameter, atLeast: number }` or `{ parameter, below: number }`, read once per pass just before the loop end; `count` still caps the passes.

`Track`: `{ name (unique), clip, alternatives? (up to 8 clips of the same length), pick? ("sequence" default or "random"), volume? (0 to 4, default 1), bus? (default: the event's), automation? }`. A track `automation` entry is `{ parameter, target: "volume" | "lowpass", curve (up to 32 keys), quantize?: "beat" | "bar" }`; a `pitch` target is an error. Every stem of a segment must be the same length.

### `playlist` and `musicSwitch`

Both are containers: `children` (up to 256 music nodes), `library` (up to 64 segments, for bridges and stingers; not children), `transitions` (up to 256 rules) and `stingers` (up to 32).

| Node | Field | Default | Meaning |
| --- | --- | --- | --- |
| `playlist` | `mode` | `"sequence"` | `"sequence"`, `"random"` (weighted pick each time) or `"shuffle"` (every child once per round) |
| | `rounds` | 1 | Whole-list repeats, 0 to 1000; 0 is forever |
| | `avoidRepeat` | 0 | In `random` and `shuffle`, skip the last n picks (capped at children - 1) |
| `musicSwitch` | `parameter` | none (plays its default) | The labelled parameter, local or global |
| | `default` | the first child | The label to play on first start and when none matches |

### Transition rules

An entry of a container's `transitions`, every field optional:

| Field | Default | Meaning |
| --- | --- | --- |
| `from`, `to` | `"*"` | The `id` of a direct child, or `"*"` |
| `exit` | `"bar"` | A `GridSpec`, `"immediate"`, `"nextCue"` or `"exitCue"` |
| `enter` | `"entryCue"` | `"entryCue"`, `"sameTime"` or `{ cue: name }` |
| `fadeOut`, `fadeIn` | 1 beat, offset 0, `"equalPower"` | `{ beats \| seconds, offset?, curve? }`; amount 0 to 64 beats or 0 to 60 s; `curve` is `"linear"`, `"sCurve"` or `"equalPower"` |
| `bridge` | none | `{ segment (a library id of the same container), fadeOut?, fadeIn? }`; a fade left out is the rule's |

The most specific rule wins in four tiers (`from` and `to` named, only `from`, only `to`, `*` to `*`), the first listed inside a tier. With no `*` to `*` rule the defaults above apply. A dangling `from`, `to` or bridge segment is dropped with a problem.

### Stingers

An entry of a container's `stingers`:

| Field | Default | Meaning |
| --- | --- | --- |
| `trigger` | required | The name `handle.trigger` takes; one namespace per event |
| `segment` | required | A library id of the same container |
| `at` | `"beat"` | A `GridSpec`, `"immediate"`, or `{ cue: name }` |
| `dontRepeat` | 0 | Seconds (0 to 3600) before the same stinger may play again |
| `ifTooLate` | `"nextGrid"` | `"nextGrid"`, `"playNow"` or `"skip"` |
| `volume`, `bus` | the segment's | Overrides; `volume` 0 to 4 |

At most 4 stingers sound at once per instance; a fifth steals the oldest with a 5 ms fade.

### Limits

| Limit | Value |
| --- | --- |
| Tempo markers, cues per segment | 64 each |
| Regions per segment, tracks per segment | 16 each |
| `alternatives` per track | 8 |
| Playlist or switch children | 256 |
| Transition rules per container, stingers per container | 256, 32 |
| `library` segments per event | 64 |
| Region `count`, child `plays`, `tailBeats` | 0 to 64, 1 to 64, 0 to 16 |
| Stem automation curve keys | 32 |

### Lint (`validateMusic`)

`validateMusic(graph, facts, options)` (`src/engine/audio/musicValidate.ts`) checks the segments against what is known about the clips and returns `{ issues, refused, neverFits, needs, peakRings }`. It runs at the first play (one warning per problem) and live in the editor's segment panel. Each `MusicLintIssue` has `code`, `severity` (`"error"` or `"warn"`), the `segment`, `track`, `clip` or `item` it is about, and a `message`. An `error` makes the segment refuse to play.

| Code | Severity | Fires when |
| --- | --- | --- |
| `stemLengthMismatch` | error | Stems differ by more than 1,024 frames |
| `stemLengthTrimmed` | warn | Stems differ by 1,024 frames or fewer (the shortest wins) |
| `stemRateMismatch`, `stemChannelsMismatch` | warn | A stem's sample rate or channel count differs |
| `noGapless` | warn | A compressed clip has no stated length (an MP3 with no Xing, Info or LAME header) |
| `flacOnLow` | warn | A streamed FLAC or WAV stem on the low preset |
| `encodedOverBudget` | warn | The segment's encoded files exceed 48 / 96 / 160 MiB (low, default, high) |
| `neverFits` | warn | A sequence needs more music rings than the pool: "needs N rings; this preset has M". A refusal at play |
| `decodedTooLong` | warn | A stem forced to decode is over 30 s |
| `silentStem` | warn | A stem is all zeros |
| `tailLongerThanLoop` | warn | A region's `tailBeats` is longer than the loop |
| `alternativeLengthMismatch` | warn | An alternative differs in length from its stem |
| `cueBeyondAudio` | warn | A cue lies past the end of the audio |
| `unknownClip` | warn | A clip is missing or not yet probed |

A clip of 30 seconds or less is decoded, a longer one streamed (`stemMode`).

### Format modules

| Module | What it holds |
| --- | --- |
| `src/engine/audio/musicTypes.ts` | The public value types above |
| `src/engine/audio/musicFormat.ts` | The node model (`SegmentNode`, `PlaylistNode`, `MusicSwitchNode`, `TempoMarker`, `MusicRegion`, `MusicTrack`), `MUSIC_LIMITS`, the lenient parsers and the writer (`musicNodeToJson`) |
| `src/engine/audio/musicPosition.ts` | `"bar:beat:tick"` parsing and formatting; `MUSIC_TICKS_PER_BEAT` (960) |
| `src/engine/audio/musicGrid.ts` | The tempo map compiled into seconds and frames |
| `src/engine/audio/musicRules.ts` | Transition rules, stingers and their resolution |
| `src/engine/audio/musicValidate.ts` | `validateMusic` and the ring-need walk |
