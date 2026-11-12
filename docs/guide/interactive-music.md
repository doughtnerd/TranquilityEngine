# Interactive music

A **music event** is a piece of music described in data. It knows its tempo and bars, so it can loop without a seam, switch to another piece on a bar line, crossfade, bring layers in and out on the beat, and play a short sound exactly on the next beat. It lives in an ordinary [sound event](sound-events.md) file (`*.audioevent.json`), plays through the same [mixer buses](audio-mixer.md), and a script drives it with `Audio.play` or an `AudioSource`.

```ts
import { Audio } from "myco";

const music = Audio.play("music/combat.audioevent.json", { parameters: { State: "explore" } });
music.setParameter("State", "combat");   // the music changes on the next bar
```

**Use a music event** when the music has to line up with itself: layers that must stay in step, a change that should land on a beat, a loop with a tempo. **Use a plain looping clip** (`AudioSource` with `loop`, or an event `clip` node) for a track that only plays on its own. A music event is flat (no 3D position) and has no pitch: `spatial` is ignored with a problem, and a `pitch` automation on a stem is an error.

Nothing plays until the player has clicked or pressed a key once; see [Why is there no sound?](why-no-sound.md).

## What works today, and what is coming later

This page documents the first part of interactive music (milestone M4a plus the switches, rules and stingers that followed). It is split like this.

| Built and public | Coming later |
| --- | --- |
| Segments with a tempo map, cues and stems; forever and counted loops (`count`), several regions, loop tails (`tailBeats`) | `while` loops: the format reads them, the player loops the region by its `count` |
| Playlists (sequence, random, shuffle), with the rule's enter, fades and bridge on each advance | |
| Music switches on a labelled parameter | |
| Transition rules: exit, enter, quantised cut, crossfade, curves, bridges; `handle.music.seek` within the playing segment | |
| Stingers and `handle.trigger`; the component callbacks `onMusicBeat`, `onMusicBar`, `onMusicCue` | `handle.onMusic` (subscribing does nothing yet) |
| Quantised stem automation | `handle.music.positionAt`, `Calibration`, a working `Audio.calibration`, and the rhythm-game helpers |
| `handle.music` position, tempo and `nextGrid` | Resyncing a group whose stream starved (it is silenced and held today, see [the debug panel](#the-debug-panels-music-section)) |
| `Audio.horizon`, `Audio.timeAt` | The editor's transport and audition for music |
| `music.rings` and the presets, streaming and decoding | Hot reload of a playing music event (wired; see [Hot reload](#hot-reload)) |
| The Audio Debug panel's Music sections | |

Where a section below depends on something in the right-hand column, it says so.

## A first music event

The flappy sample's town music (`samples/flappy/music/town.audioevent.json`) is the smallest useful one: one stem, looping forever on a 105 bpm grid.

```json
{
  "format": "myco.audioevent@1",
  "bus": "Music",
  "priority": 200,
  "limit": { "maxInstances": 1, "steal": "oldest" },
  "root": {
    "type": "segment",
    "id": "town",
    "tempo": [{ "at": "1:1:0", "bpm": 105, "beatsPerBar": 4, "beatUnit": 4 }],
    "cues": [
      { "name": "entry", "at": "1:1:0" },
      { "name": "exit", "at": "end" }
    ],
    "entry": "entry",
    "exit": "exit",
    "regions": [{ "id": "loop", "from": "1:1:0", "to": "end", "count": 0 }],
    "tracks": [{ "name": "town", "clip": "music/town.mp3", "volume": 0.35 }]
  }
}
```

A node in the sample's `music.prefab.json` has an `AudioSource` whose `clip` is that event and `playOnAwake` is on. That is all a game needs to start music. The common event keys (`bus`, `priority`, `limit`, `volume`, `parameters`) are the ones in [Sound events](sound-events.md#the-file).

The `root` of a music event is a **segment**, a **playlist** or a **musicSwitch**. The rest of this page builds up from the segment.

## Segments, tempo and the grid

A **segment** is one piece of music with a clock. Every music node needs an `id` (1 to 48 letters, digits, `_` or `-`, unique in the event); rules, scripts and the debug panel name nodes by it.

### Positions

A musical position is the text `"bar:beat:tick"`. Bars and beats count from 1, and a beat has 960 ticks (tick 0 to 959). `"1:1:0"` is the start of the grid. `"start"` is the start of the file and `"end"` the end of the audio, and those two are allowed where a cue or a region says so. Durations are plain numbers: beats, or seconds where a field says seconds.

### The tempo map and `gridOffset`

```json
"gridOffset": 0.5,
"tempo": [
  { "at": "1:1:0", "bpm": 120, "beatsPerBar": 4, "beatUnit": 4 },
  { "at": "9:1:0", "bpm": 90,  "beatsPerBar": 3, "beatUnit": 4 }
]
```

- `tempo` has 1 to 64 markers; the first is at `1:1:0`. With none it is 120 bpm in 4/4. `bpm` is beats per minute, a beat being the `beatUnit` note (1, 2, 4, 8 or 16). `beatsPerBar` is 1 to 32.
- A marker sits on a beat. A change of metre must sit on beat 1 of a bar; if it does not it moves to the next bar and the parse says so.
- `gridOffset` is the number of seconds of audio before bar 1, beat 1. A piece with a pickup before the first downbeat sets it, so bar 1 is where the music's beat is, not where the file starts.

If you only know the clip and how many bars it holds, `node tools/music-tempo.mjs <clip.wav> --bars 4` prints the tempo (`--hints` reads it from the file's own metadata). The editor's segment panel can also work it out from the length, and has a tap-tempo button.

### Cues, entry and exit

A **cue** is a named position: `{ "name": "hit", "at": "3:3:0" }` (up to 64, unique names). Two cues have a meaning:

- `entry` names the cue where the segment is *entered*: the first note you are meant to hear. Audio before it (the pickup) plays early so the entry lands on the beat.
- `exit` names the cue where the segment is *left*. Audio after it, the tail, keeps ringing under whatever follows until it ends.

With no `entry` the grid start (`1:1:0`) is the entry, and with no `exit` the end of the audio is the exit. Cues stay on their beat when you edit the tempo; they do not move with seconds.

### Tracks and stems

A **track** is one stem, one layer of the piece (drums, bass, pad), as one clip. All tracks of a segment start together and stay in step.

```json
"tracks": [
  { "name": "drums", "clip": "music/e-drums.ogg", "volume": 1, "bus": "Drums" },
  { "name": "pad",   "clip": "music/e-pad.ogg", "alternatives": ["music/e-pad-b.ogg"], "pick": "sequence" }
]
```

| Field | Meaning (default) |
| --- | --- |
| `name` | Unique within the segment |
| `clip` | The audio asset |
| `volume` | 0 to 4 (1) |
| `bus` | A bus name for this stem only (the event's bus) |
| `alternatives` | Up to 8 other clips of the **same length**; one is chosen per pass |
| `pick` | `"sequence"` (default) or `"random"` for the alternatives |
| `automation` | Parameter-driven volume or low-pass, optionally [quantised](#quantised-automation) |

A segment has 1 to 16 tracks. **Every stem of a segment must be exactly the same length** (and have the same sample rate and channel count). If they differ by more than 1,024 frames the segment refuses to play; by 1,024 frames or fewer the shortest wins, with a warning. Export all stems from your editing program from the same start to the same end, with the tail padded in.

Compressed files need a stated length so that a loop is gapless: WAV, FLAC, Ogg Vorbis and AAC are fine, and an MP3 needs an Xing, Info or LAME header (an MP3 without one is reported as `noGapless`). The flappy sample's `town.mp3` has such a header.

The lint that finds these (`validateMusic`, `src/engine/audio/musicValidate.ts`) runs at the first play, and warns once per problem; the editor's segment panel shows the same rows live.

## Loop regions

A **region** loops a part of the segment:

```json
"regions": [{ "id": "loop", "from": "1:1:0", "to": "end", "count": 0 }]
```

`count: 0` loops forever; `count` from 2 to 64 plays that many passes in all and then plays on past the region (`count: 1` is one pass, no loop). The loop is sample-exact, the grid keeps counting bars through the passes, and every stem of the segment wraps on the same frame. Both samples use a forever loop over the whole clip.

A segment may have several regions (up to 16). They play in file order: the music loops the first region its passes, then plays on into the next one and loops that, and so on. A region at or after the exit cue is never reached.

**Loop tails.** `tailBeats` (0 to 16) lets the end of a pass ring over the start of the next:

```json
"regions": [{ "id": "loop", "from": "1:1:0", "to": "9:1:0", "count": 0, "tailBeats": 4 }]
```

Bounce the stems with the audio after the loop end left in (the reverb and decay of the last bar). At each wrap the player plays those `tailBeats` beats after `to`, from the stems' own files, on the wrap's exact sample, while the next pass starts from `from` on the grid. The last pass of a counted loop needs no tail: the music plays on into that audio by itself. A change that leaves the loop exactly at its end (for example a bar exit on the region's last bar line) keeps the tail ringing under the new segment; a change earlier in the pass plays no tail. Tails are decoded into memory (each up to 30 s, counted against the clip memory limit) and need no music ring. A tail the clip memory can't hold is dropped with one warning, `tailRefused`, and the loop goes on without it. `handle.stop` fades the tails with the stems. A tail plays at the stem's level, without its quantised automation. The Babylon fallback plays no tails.

A segment with no region plays once. Then it ends, or hands over to the next item of a [playlist](#playlists). A forever loop never reaches its exit by itself, so a playlist never advances past a segment with one: leave a looping item for last, use a counted loop, or change segments with a [switch or a script](#transitions).

*Coming later:* `while` (`{ "parameter": "Boss", "is": "alive" }`, or `atLeast` or `below` for a numeric parameter) to keep looping while a condition holds. It is read, validated and written back by the editor, but today the player loops the region by its `count` (forever for 0) whatever the condition.

## Quantised automation

A stem can follow a parameter, like any [event automation](sound-events.md#automation-and-curves), but a music stem can follow it **on the grid**. With `quantize` the stem's level is read at each beat or bar and applied as a short ramp (20 ms) that starts exactly on that grid point, so a layer enters on the downbeat instead of fading in across a bar.

The sound-lab's `music-intensity` event (`samples/sound-lab/audio/events/music-intensity.audioevent.json`) is the worked example: one 120 bpm segment looping three stems, with a pad that is always there and a pulse and a lead that come in as the global parameter `Intensity` rises.

```json
"tracks": [
  { "name": "pad", "clip": "audio/events/music-pad.wav", "volume": 0.8 },
  { "name": "pulse", "clip": "audio/events/music-pulse.wav",
    "automation": [{ "parameter": "Intensity", "target": "volume", "curve": [[0.2, 0], [0.6, 1]], "quantize": "beat" }] },
  { "name": "lead", "clip": "audio/events/music-lead.wav",
    "automation": [{ "parameter": "Intensity", "target": "volume", "curve": [[0.6, 0], [1, 1]], "quantize": "beat" }] }
]
```

`Intensity` is declared once in the sample's `project.json` (`audio.parameters`, 0 to 1, `seekSpeed` 0.5). Its script (`samples/sound-lab/scripts/behaviors/MusicIntensity.ts`) just calls `Audio.setParameter("Intensity", value)`; the music does the rest. With intensity 0.5 only the pad and the start of the pulse sound; at 1 all three do.

- `quantize` is `"beat"` or `"bar"`. Leave it out and the stem follows the parameter continuously, as in any event.
- The `target` is `volume` or `lowpass`. `pitch` is an error on music.
- Between grid points the stem does **not** follow the parameter. A parameter with a `seekSpeed` still glides; the stem takes the value it has at the next grid point.
- A stem at level 0 is silent and takes no mixing voice while it is.

## Playlists

A **playlist** plays its children one after another, each a segment or another container. It moves on when the playing child reaches its exit cue, so the next one starts on the beat with no gap.

```json
{ "type": "playlist", "id": "levels", "mode": "shuffle", "rounds": 0, "avoidRepeat": 1,
  "children": [
    { "type": "segment", "id": "forest", "plays": 2, "tracks": [ /* ... */ ] },
    { "type": "segment", "id": "river",  "tracks": [ /* ... */ ] },
    { "type": "segment", "id": "cliffs", "weight": 3, "tracks": [ /* ... */ ] }
  ] }
```

| Field | Meaning (default) |
| --- | --- |
| `mode` | `"sequence"` in order (default), `"random"` a weighted pick each time, `"shuffle"` every child once per round, in random order |
| `rounds` | How many times the whole list plays; 0 is forever (1) |
| `plays` (on a child) | How many times that child plays before moving on, 1 to 64 (1) |
| `weight` (on a child) | The chance in `random` mode (1) |
| `avoidRepeat` | In `random` and `shuffle`, skip the last n picks (0) |

A playlist holds up to 256 children, and playlists may nest. The next child is primed while the current one plays, so a streamed segment is ready in time. The advance always leaves at the playing segment's exit cue; the matching [transition rule](#transitions) decides how the next child is entered (`enter`), its fade-in and any bridge (its `exit` is ignored). The old segment is not faded: its tail rings on under the new one until it ends. With no rule written for the change, the advance is gapless: the next child starts at full level on its entry cue (the default rule's one-beat fade is for changes, not for a playlist's own sequence).

The picks are seeded like other random picks: set `audio.seed` in `project.json` to repeat them in a test ([Random seeds for tests](sound-events.md#random-seeds-for-tests)).

## Music switches

A **musicSwitch** plays the child whose `value` matches a labelled parameter and changes children when the parameter changes.

```json
{
  "format": "myco.audioevent@1",
  "bus": "Music",
  "parameters": [{ "name": "State", "labels": ["explore", "combat"], "default": "explore" }],
  "root": {
    "type": "musicSwitch", "id": "world", "parameter": "State", "default": "explore",
    "children": [
      { "type": "segment", "id": "explore", "value": "explore", "tracks": [ /* ... */ ] },
      { "type": "segment", "id": "combat",  "value": "combat",  "tracks": [ /* ... */ ] }
    ]
  }
}
```

The parameter is labelled, local (in the event's `parameters`) or global (in `audio.parameters`); see [Parameters](sound-events.md#parameters). Set it with `handle.setParameter` or `Audio.setParameter`.

- The first start plays the child whose `value` is the `default` label, else the first child.
- A change of the parameter does not cut. It asks for a **transition** from the playing child to the new one, and the [rules](#transitions) say when it lands (the next bar, by default).
- If the parameter changes again before the change lands, the latest value wins and two changes inside one bar land once. Setting it back to the playing child cancels the change.
- A value that matches no child is ignored and the playing child plays on. (The default only applies to the first start.)
- Unlike the sound-event `switch` there is no `onChange`. The rules decide.

A switch child may itself be a playlist or another switch.

## Transitions

A change between two segments is a **transition**. A switch asks for one when its parameter moves, and so does anything that changes the target, such as a script setting the parameter. The container's `transitions` list says how:

```json
"transitions": [
  { "from": "explore", "to": "combat", "exit": "nextCue", "enter": "entryCue",
    "fadeOut": { "beats": 1, "curve": "equalPower" }, "fadeIn": { "beats": 1, "curve": "equalPower" } },
  { "from": "combat", "to": "explore", "exit": { "every": "bar", "n": 2 },
    "fadeOut": { "seconds": 2, "curve": "sCurve" }, "fadeIn": { "seconds": 2, "curve": "sCurve" } },
  { "from": "*", "to": "*", "exit": "bar" }
]
```

| Field | Values (default) |
| --- | --- |
| `from`, `to` | The `id` of a **direct child** of the container, or `"*"` for any (`"*"`) |
| `exit` | When to leave the playing segment: `"beat"`, `"bar"`, `{ "every": "bar", "n": 2 }` (every n-th, 2 to 64), `"immediate"`, `"nextCue"` or `"exitCue"` (`"bar"`) |
| `enter` | Where to enter the new segment: `"entryCue"` (its entry cue, starting its pickup early), `"sameTime"` (the same musical position, no pickup), or `{ "cue": "name" }` (`"entryCue"`) |
| `fadeOut`, `fadeIn` | `{ beats or seconds, offset?, curve? }`: the fade's length, an optional offset from the exit point (may be negative) and a curve. Default: 1 beat, `equalPower` |

**Quantised cut and crossfade.** The change lands on the exit point, on one exact sample. A fade length of 0 is a *cut*: the old segment stops and the new one starts there. A longer fade is a *crossfade*: the old segment's stems fade out and the new ones fade in, both starting at the exit point (use a negative `offset` to start the fade before it). If the exit is `exitCue`, or a grid exit that falls after the exit cue, the change waits for the exit cue and the old segment is not faded; its tail rings on under the new segment until it ends.

**Curves.**
- `linear`: straight ramps.
- `sCurve`: slow at both ends.
- `equalPower`: the default; the two ramps are power-complementary, so the loudness of a crossfade stays constant (`linear` dips in the middle).

The curves run in the audio core, in the voice, on the sample; see [Fades and stops](sound-events.md#fades-and-stops) for how.

**Which rule wins.** The most specific one, in four tiers: both `from` and `to` named, then only `from`, then only `to`, then `*` to `*`. Inside a tier the first listed wins, and the parse warns about a duplicate and about a rule that never wins. Without a `*` to `*` rule the defaults in the table apply. A change between segments under different children of a container, however deep, uses the **nearest common parent's** table, where `from` and `to` name the children that hold the two segments. A dangling `from` or `to` is dropped with a problem.

**What the player does.** A change is planned, not reactive: the new segment is loaded and started on the audio thread's clock at the exit point, so a streamed segment is asked for about 100 ms before it (more if loading is slow). A change asked too late for its planned point lands on the next point of the same kind and the debug panel counts a re-plan.

**Bridges.** `"bridge": { "segment": "riser", "fadeOut"?, "fadeIn"? }` plays a segment from the container's `library` between the two: the old segment, then the bridge, then the new one. Each seam has its own fades:

| Seam | When | Fades |
| --- | --- | --- |
| Old segment to bridge | The rule's `exit` point on the old segment | The rule's `fadeOut` (old segment) and `fadeIn` (bridge) |
| Bridge to new segment | The bridge's exit cue | The bridge's `fadeOut` (bridge) and `fadeIn` (new segment); each one left out is the rule's |

The bridge enters on its own entry cue (its pickup starts early); the rule's `enter` places the new segment. Unlike an ordinary exit at the exit cue, the bridge's fade-out is applied, so a bridge with audio after its exit cue can crossfade into the new segment. For a riser that should hand over on its last beat, set the bridge's fades to `{ "beats": 0 }`: the new segment then starts at full level on the bridge's exit cue, on one exact sample. Once the old segment's fade has started the change goes through; a change asked after that waits for it and is planned from the new segment.

A bridge under 30 s is decoded and needs no music ring. The new segment is prepared while the bridge plays; if the pool cannot hold it by the time the old segment would start fading, the whole change is refused, the old segment plays on and the log warns once (`poolFull`). A streamed bridge can still go ahead when the pool has room for the bridge and the new segment once the old segment's rings come back and the bridge is long enough to prepare the new segment after that (the old segment's fade, plus about 0.12 s); a shorter one is refused the same way.

## Stingers

A **stinger** is a short sound that plays over the music, exactly on a grid point, without changing the music or its grid. It lives in a `stingers` list on a container, and plays a segment from the container's `library`:

```json
{ "type": "musicSwitch", "id": "world", "parameter": "State", "children": [ /* ... */ ],
  "stingers": [
    { "trigger": "secret", "segment": "hit", "at": "beat", "dontRepeat": 2, "ifTooLate": "nextGrid", "volume": 0.8 }
  ],
  "library": [
    { "type": "segment", "id": "hit", "tracks": [{ "name": "hit", "clip": "music/secret.wav" }] }
  ] }
```

```ts
const accepted = music.trigger("secret");   // false: unknown name, dropped, or refused
```

| Field | Meaning (default) |
| --- | --- |
| `trigger` | The name a script passes to `handle.trigger` (one namespace per event) |
| `segment` | The id of a `library` segment |
| `at` | A grid spec (`"beat"`, `"bar"`, `{ "every": "bar", "n": 2 }`), `"immediate"`, or `{ "cue": "name" }` for the next time the playing segment reaches that cue (`"beat"`) |
| `dontRepeat` | Seconds during which the same stinger is not played again (0) |
| `ifTooLate` | When the point has already passed: `"nextGrid"` plays at the next one (default, with a warning), `"playNow"`, `"skip"` |
| `volume`, `bus` | Override the stinger segment's gain and bus |

- **`library`** holds the segments that stingers (and bridges) use. They are not children of the playlist or switch. Up to 64 per event.
- With several stingers of the same trigger name, the one on the deepest container above the playing segment wins, then the first listed.
- At most **4 stingers sound at once** per instance; a fifth steals the oldest with a 5 ms fade.
- Keep stinger segments short and decoded (under 30 s): a streamed stinger takes a music ring for as long as it plays.
- `trigger` returns `true` when the stinger is accepted. It returns `false` for an unknown name, when `dontRepeat` or `ifTooLate: "skip"` drops it, when the pool has no ring for a streamed one, and before the music has started.

## Streaming versus decoding

Every stem is either **decoded** (the whole clip is decoded into memory before it plays) or **streamed** (read from the file as it plays, through a *music ring*, a buffer in the audio core).

- A stem **30 seconds or shorter is decoded**; a longer one is **streamed**. This is automatic, by the clip's length. Where the length is not known yet the clip's [import setting](playing-sound.md#sound-files) `stream` decides.
- Streaming keeps memory low but needs a ring, and a start has to be asked for early so the ring is full in time. Decoding costs memory but starts instantly and costs no ring.
- The flappy sample's `town.mp3` is about 80 seconds, so it streams; the sound-lab's 4-second stems are decoded.

**`music.rings`** is the number of music rings, 0 to 16, in `project.json`:

```json
"audio": { "music": { "rings": 12 } }
```

Each streamed stem sounding, or being prepared for the next change, uses one ring (about 300 KB each). The default is 12; the editor's voice presets set it: **low 8, default 12, high 16** (Project Settings > Audio). Music rings are part of the preset's voice budget, not an addition to it. With 0 streamed stems are refused with a warning, and decoded ones still play.

Count the rings you need at the busiest moment: all the streamed stems of the playing segment, plus those of the next one while it is being prepared (a crossfade has both). A segment of 4 streamed stems changing to another of 4 needs 8. If the pool cannot hold the change, the segment is refused and the debug panel says `poolFull`, or `neverFits` when it can never fit (the lint says "needs N rings; this preset has M" before you play). Either keep some stems under 30 s, merge stems, or raise the preset.

## Scripting

A music event plays with `Audio.play` or an `AudioSource`, like any event, and `handle.music` is the music's state:

```ts
import { Audio } from "myco";

const music = Audio.play("music/world.audioevent.json", {
  parameters: { State: "explore" },
  at: Audio.time + 1,                 // optional: when the entry cue is heard
});

music.setParameter("State", "combat");

const m = music.music;                // undefined for an event that is not music
if (m) {
  m.segment;       // id of the playing segment; null until the first one is heard
  m.bar; m.beat;   // 1-based
  m.beatFraction;  // 0..1 through the beat
  m.tempo;         // beats per minute
  m.beatsPerBar; m.beatUnit;
  m.time;          // heard time (seconds) of that position
  m.transition;    // null, or { to: "combat", time } while a change is pending
  m.nextGrid("bar");                       // { time, bar, beat, segment } or null
  m.nextGrid({ every: "bar", n: 4 });
}
music.trigger("secret");              // fire a stinger
```

Everything is exported from `"myco"` (`GridSpec`, `GridPoint`, `MusicHandle`, `MusicEvent`, `MusicSeekResult`, and the others).

| Member | What it does |
| --- | --- |
| `handle.music` | The music state, or `undefined` for a non-music handle (never an empty object) |
| `music.segment`, `bar`, `beat`, `beatFraction`, `tempo`, `beatsPerBar`, `beatUnit` | Where the music is **as it is heard**, not as it is scheduled. `segment` is `null` while the first segment is still being prepared, and then `bar` and `beat` read 1 and `tempo` 0 |
| `music.time` | The heard time in seconds of that position, on `Audio.time`'s clock |
| `music.transition` | The pending change, with the heard time it lands: `{ to, time }`, or `null` |
| `music.nextGrid(spec)` | The next beat, bar or n-th bar line at or after now, as `{ time, bar, beat, segment }`. While a change is pending, points after `transition.time` belong to the *new* segment (`segment` says which). `null` when not playing or when nothing follows the exit |
| `music.seek(position)` | Jump to a position in the segment that is playing, see [Seeking](#seeking) |
| `handle.trigger(name)` | Fire a [stinger](#stingers); `true` if accepted |
| `handle.setParameter(name, value)` | Drives a [switch](#music-switches) and stem automation, as for every event |
| `handle.stop(fade)`, `handle.fade(to, seconds)`, `handle.release()` | As for every event handle. `stop(fade)` fades all stems at once and is not quantised |
| `Audio.horizon` | Seconds, the earliest heard time at which a *stamped start of a decoded clip* is exact (now plus the audio core's lookahead). Not a promise for a streamed clip |
| `Audio.timeAt(performance.now())` | The heard time of a `performance.now()` instant, such as an input's `event.timeStamp`. Raw: no calibration is applied |
| `Audio.time` | The audio clock in seconds, as for all sounds |

`nextGrid` is how a script lines something up with the music, for example a visual flash on the next bar:

```ts
const next = music.music?.nextGrid("bar");
if (next) flashAt(next.time - Audio.time);   // seconds from now
```

### Beat, bar and cue callbacks

A `GameBehavior` on the same node as the `AudioSource` that plays the music defines the hooks it wants; defining one is the subscription, and music nobody listens to costs nothing.

```ts
@behavior("game.Pulse")
export class Pulse extends GameBehavior {
  onMusicBeat(e: MusicEvent) { this.transform.scale = 1.2; }
  onMusicBar(e: MusicEvent) { /* e.beat is 1 */ }
  onMusicCue(e: MusicEvent) { if (e.cue === "drop") this.flash(); }
}
```

They run in the update phase just before `update`, in the frame whose window holds the beat's heard time, so `e.heardIn` (seconds until it is heard, `e.time - Audio.time`) is under one frame: schedule the visible response for that moment. After a gap longer than a beat (a hitch, a hidden tab) the beats of that kind arrive as one call with `e.missed` set, and coalesced cues are named in `e.skippedCues`. `e` is reused: read it during the call and don't keep it. A hook that throws is logged and the others still run.

### Seeking

```ts
const r = music.seek("5:1:0");   // bar 5, beat 1, tick 0
if (r.ok) console.log("lands at", r.time);          // heard seconds, on Audio.time's clock
else if (!r.permanent) retryNextFrame();            // no free streaming slots yet, or the music has not started sounding
```

`seek` takes `"bar:beat:tick"` (bar and beat from 1, tick from 0 to 959; `"5:3"` and `"5"` fill in the rest) and moves the music to that place **in the segment playing when the seek lands**. It is a change like any other: it crossfades over 5 ms and lands on the earliest frame the audio core can stamp, a fraction of a second after the call, not on a beat.

- A position past the end of the audio goes to the end; a position before the entry cue (in the pickup) is allowed and enters exactly there. At or past the exit cue the segment plays on from there, and a playlist then advances as at a natural end.
- A change that has not yet passed its cancel point is replaced by the seek. One that has is left to land, and the seek happens after it, in the *new* segment.
- Only the position moves. The playlist cursor and each item's `plays` count, the switch value and the alternative picks stay as they were, and the skipped span fires no missed beats or cues.
- Seeking to a different segment is **not** a seek: change the switch parameter or advance the playlist, and the rules apply. A position is never read in another segment.
- Refusals: `invalid` (not a position, a beat the bar does not have, or no playable track) and `notPlaying` (stopping, stopped or refused) and `neverFits` (the segment can never hold two sets of streaming slots on this preset) are permanent. `poolFull` (no free slots now) is temporary, and so is `notPlaying` before the first segment has started sounding; call again on a later frame. A refused seek did not happen and leaves nothing planned, though a pending change it would have replaced is gone.

`at` in `Audio.play` is the heard time the *entry cue* is heard; the pickup starts earlier. An `at` closer than the time the player needs to prepare starts at the earliest possible moment instead. Nothing is a grid before the first segment: that moment becomes bar 1 of the grid and every later change lands on it.

An `AudioSource` plays a music event like any event (the flappy sample does). Its `loop`, `spatial` and distance fields are ignored for music, and `pitch` is ignored with a warning.

*Coming later:*
- **`handle.onMusic`.** `handle.onMusic("beat", fn)` is in the types but returns a no-op unsubscribe for now. For music you start yourself with `Audio.play`, read `music.nextGrid("beat")` each frame, or put the music on an `AudioSource` and use the component callbacks below.
- **`music.positionAt(performance.now())`** returns an empty position (`segment: null`), and **`Calibration.fromTaps`** returns an empty result. **`Audio.calibration`** can be set and read but is not saved, and `Audio.calibrationStale` is always `false`. `Audio.latency` and `Audio.rhythmMode` (the `audio.rhythmMode` project setting) exist; the rhythm mode they belong to is not finished.

## The debug panel's Music section

The editor's Audio Debug panel (the same one [Why is there no sound?](why-no-sound.md) uses) has two music sections. `Audio.debug().music` and `Audio.debug().musicTotals` hold the same data for tools.

**Music totals** is the engine-wide health:

| Row | Meaning |
| --- | --- |
| Music rings in use | Rings used now, the pool's size (`music.rings`) and the high-water mark. Amber when every ring is in use |
| Music rings refused | Streamed stems refused for lack of a ring. Red on any |
| Stream starts late | Streams that started after their group. Red on any |
| Quantum splits (music) | Whole-block splits caused by music. Red on any; it should stay 0 |
| Voice splits, Largest slip | Informational |
| Curve pool full | Fades that found the shaped-fade pool full (255) and fell back to linear. Amber |
| Group table full | Groups refused because the core's 16-entry group table was full. Red on any |
| Encoded cache over budget | Times the decoder's encoded-file cache exceeded its budget with nothing it could drop (every file in use or about to be). Amber; it also logs one warning per music event. Use smaller or fewer stems, or a higher voice preset |
| Groups abandoned, Late groups, Groups held, Music recoveries | Summed over instances; the first and last also show a per-minute rate |
| Deadline re-plans | Re-plans per 100 transitions over the last minute: green below 1, amber to 10, red above |

**Music** has one row per playing music event:

| Column | Meaning |
| --- | --- |
| Event, State | The instance and its asset; `priming`, `playing`, `transitioning`, `recovering` or `ending` |
| Segment, Position, Tempo | The playing segment and its pass (loop count), `bar:beat:tick`, bpm and beats per bar |
| Pending | The waiting change: its target, `bar:beat` and the rule that chose it (tier, `from>to`, which container, exit, enter). **This is where to look when a switch changes at an unexpected time.** |
| Groups, Stems | How many of the stems are primed, and for each stem its music ring, or "decoded" |
| Prime (ms) | Last prime time, the running estimate and the lead the player asks ahead by. Green up to 150 ms, amber up to one beat, red above |
| Re-plans, Refusals | Counts by cause. `poolFull`, `leadOverBeat` and `tailRefused` are amber; `neverFits` and the rest red |
| Late / held / timeouts, Last slip | Groups that started late, groups the core held because a stream ran dry, and groups it gave up on, with the slip in frames and milliseconds |
| Recoveries | By cause: `rebuild`, `hidden`, `reload`, `crash`. After a recovery the music re-enters on the next bar |
| Missed beats, Stingers | Beats coalesced, and stingers `played`, `late`, `skipped` or `dropped` |

If a streamed stem runs dry, its whole group is silenced together and resumes together, so the layers never drift; the Late and held counters rise. Raising `music.rings` does not help with that; a faster disk or a smaller file does, or decode the stem.

Each refusal, re-plan and slip also logs one warning for its cause, so a console without the panel shows the same story.

## Hot reload

Editing a stem or the event file while the music plays swaps the music at the next bar, without a gap: the changed segment is prepared in the background and the old stems fade out over a few milliseconds as the new ones start, at the same file position when the tempo map has not changed, otherwise at the entry cue. An event file that is gone or invalid keeps the old version with one warning. The debug panel counts such a swap under Recoveries, as `reload`.

In the editor this fires when the project saves a file: saving a stem's audio file or the event asset tells the audio runtime, which drops its cached copy of the file (the decoded clip and the decoder's encoded bytes) and swaps every playing instance that uses it. A change to the event file that leaves the playing segment as it was only replaces the rules, playlists, switches and stingers, which apply at the next decision. A second edit that arrives while a swap is being prepared waits until the first one has started. The wiring is `Assets.onChanged` (fired by the editor project's writes) to `noteAssetChanged` in `src/plugins/audio/runtime/music/reload.ts`; a game running outside the editor never changes its files, so nothing fires there.

## Limits

| Limit | Value |
| --- | --- |
| Tempo markers, cues per segment | 64 each |
| Regions per segment | 16 |
| Tracks (stems) per segment | 16 |
| `alternatives` per track | 8 |
| Playlist or switch children | 256 |
| Transition rules per container | 256 |
| Stingers per container | 32 |
| `library` segments per event | 64 |
| Nodes per event, nesting depth | 1,024, 16 (the library's segments count) |
| `music.rings` | 0 to 16 |
| Stingers sounding at once | 4 per instance |
| Decoded stem length | 30 s (longer streams) |

Past a limit the extras are dropped with a problem. Music nodes read and ignore `pitch`, `pitchRandom`, `delay`, `range` and `fade`, with one problem each.

## See also

- [Sound events](sound-events.md): the file, parameters, automation curves, `Audio.play`.
- [Playing sound](playing-sound.md) and [Audio mixer](audio-mixer.md): buses, formats, streaming.
- [Why is there no sound?](why-no-sound.md): the debug panel.
- Design: `docs/decisions/0166-interactive-music-segments-transition-rules-and-a-heard-beat-clock.md` and `0167-interactive-music-design-corrections-and-owner-decisions.md`.
