# Interactive music

A **music event** is a piece of music described in data. It knows its tempo and bars, so it can loop without a seam, switch to another piece on a bar line, crossfade, bring layers in and out on the beat, and play a short sound exactly on the next beat. It lives in an ordinary [sound event](sound-events.md) file (`*.audioevent.json`), plays through the same [mixer buses](audio-mixer.md), and a script drives it with `Audio.play` or an `AudioSource`.

```ts
import { Audio } from "myco";

const music = Audio.play("music/combat.audioevent.json", { parameters: { State: "explore" } });
music.setParameter("State", "combat");   // the music changes on the next bar
```

**Use a music event** when the music has to line up with itself: layers that must stay in step, a change that should land on a beat, a loop with a tempo. **Use a plain looping clip** (`AudioSource` with `loop`, or an event `clip` node) for a track that only plays on its own. A music event is flat (no 3D position) and has no pitch: `spatial` is ignored with a problem, and a `pitch` automation on a stem is an error.

Nothing plays until the player has clicked or pressed a key once; see [Why is there no sound?](why-no-sound.md).

## What is built, and what is a follow-up

Interactive music is complete for its first release (milestone M4). Everything in the left column is built, public and tested; the right column is what is known to be missing, with where the guide says more. The reference for every name is [Interactive music: API reference](interactive-music-api.md).

| Built and public | Follow-ups (not built) |
| --- | --- |
| Segments with a tempo map, cues and stems; forever, counted and `while` loops, several regions, loop tails | **Editor transport:** stem solo and mute change nothing you hear (they have no runtime API), and playback cannot start at a later playlist item |
| Playlists (sequence, random, shuffle) and music switches on a labelled parameter | **A starved stream** is silenced and held, with its whole group, and the core gives up after a second; it is not resynced in place (see [the debug panel](#the-debug-panels-music-section)) |
| Transition rules: exit, enter, quantised cut, crossfade, curves, bridges | |
| Stingers and `handle.trigger` | **A 192 kHz output** is short of the audio core's fixed memory on the default and high presets (the low preset fits); use a 44.1, 48 or 96 kHz context |
| Quantised stem automation | |
| `handle.music` position, tempo, `nextGrid`, `seek` and `positionAt` (with `judged`) | **Real-device checks** (phone prime lead, other browsers' output latency, the lab VM) are the owner's [listening pass](../design/0166-audio-music/listening-pass.md); this guide's numbers come from tests and a desktop browser |
| The component callbacks `onMusicBeat`, `onMusicBar`, `onMusicCue`, and `handle.onMusic` for music started with `Audio.play` | |
| `Calibration.fromTaps`, `Audio.calibration` (saved per output device, on the Babylon fallback too), `Audio.calibrationStale` | |
| `audio.rhythmMode` and `music.rings`, both in Project Settings > Audio; `Audio.latency`, `Audio.horizon`, `Audio.timeAt` | |
| Beat, bar and cue callbacks on the Babylon fallback (not corrected for output latency; no rhythm mode there) | |
| Streaming and decoding; hot reload; the Audio Debug panel's Music sections | |
| Editor: segment view and properties, transition rules table and rule editor, audition | |
| Samples: the Sound Lab's music and rhythm pages (keyboard or on-screen buttons), Flappy's town music with a game-over dip and a readout | |

Where a section below depends on something in the right-hand column, it says so. The Sound Lab's [music page](#the-sound-lab-music-page) is the worked example for switches, rules, stingers and loops, and its [rhythm page](#the-sound-lab-rhythm-page) for [callbacks](#beat-bar-and-cue-callbacks) and [calibration](#rhythm-mode-and-calibration).

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

A node in the sample's `music.prefab.json` has an `AudioSource` whose `clip` is that event and `playOnAwake` is on. That is all a game needs to start music. The same instance plays through the start, the run, game over and the restart. On game over `GameManager` dips the `Music` bus to 35% over 0.4 s (`Audio.bus("Music").fadeTo`) and the next run brings it back; a bus fade moves no beat. In the sample, **M** (or the round ♪ button on a touch screen) shows a readout of the music's health: the prime lead, the prime time and the late and held group counts (the same numbers as the [debug panel](#the-debug-panels-music-section)). The common event keys (`bus`, `priority`, `limit`, `volume`, `parameters`) are the ones in [Sound events](sound-events.md#the-file).

The `root` of a music event is a **segment**, a **playlist** or a **musicSwitch**. The rest of this page builds up from the segment. Its worked example for switches, rules, bridges, stingers and loops is the Sound Lab's music page, described [below](#the-sound-lab-music-page).

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

## Loops

A **region** loops a part of the segment:

```json
"regions": [{ "id": "loop", "from": "1:1:0", "to": "end", "count": 0 }]
```

`count: 0` loops forever; `count` from 2 to 64 plays that many passes in all and then plays on past the region (`count: 1` is one pass, no loop). The loop is sample-exact, the grid keeps counting bars through the passes, and every stem of the segment wraps on the same frame.

A segment may have several regions (up to 16). They play in file order: the music loops the first region its passes, then plays on into the next one and loops that, and so on. A region at or after the exit cue is never reached.

A segment with no region plays once. Then it ends, or hands over to the next item of a [playlist](#playlists). A forever loop never reaches its exit by itself, so a playlist never advances past a segment with one: leave a looping item for last, use a counted loop or a `while` loop, or change segments with a [switch or a script](#transitions).

### Loop tails

`tailBeats` (0 to 16) lets the end of a pass ring over the start of the next:

```json
"regions": [{ "id": "loop", "from": "1:1:0", "to": "9:1:0", "count": 0, "tailBeats": 4 }]
```

Bounce the stems with the audio after the loop end left in (the reverb and decay of the last bar). At each wrap the player plays those `tailBeats` beats after `to`, from the stems' own files, on the wrap's exact sample, while the next pass starts from `from` on the grid.

- The last pass of a counted loop needs no tail: the music plays on into that audio by itself.
- A change that leaves the loop exactly at its end (a bar exit on the region's last bar line, say) keeps the tail ringing under the new segment; a change earlier in the pass plays no tail.
- Tails are decoded into memory (each up to 30 s, counted against the clip memory limit) and need no music ring. A tail the clip memory can't hold is dropped with one warning, `tailRefused`, and the loop goes on without it.
- `handle.stop` fades the tails with the stems. A tail plays at the stem's level, without its quantised automation.
- The [Babylon fallback](#the-babylon-fallback) plays no tails.

### Looping while a condition holds

`while` keeps a region looping only while a parameter of the event says so:

```json
"regions": [{ "id": "body", "from": "1:1:0", "to": "3:1:0", "count": 0, "tailBeats": 4, "while": { "parameter": "Loop", "is": "hold" } }]
```

`is` compares a labelled parameter's label (a numeric parameter's value as text); `atLeast` and `below` compare a numeric parameter (`{ "parameter": "Danger", "atLeast": 0.5 }` loops while Danger is 0.5 or more).

The condition is read once per pass, just before the loop end: one look-ahead plus a frame plus 10 ms before it (about 60 ms at 60 frames a second). If it no longer holds, that pass is the last. The region doesn't wrap: the music plays on past `to` on the same sample, through the audio after the loop end (no separate tail is played for that wrap, since the music plays into the same audio itself) and on to the exit cue, where the segment ends or its playlist moves on. A change made after the read waits for the next pass, and so does one missed because the game stalled over it.

`count` still caps the passes: `count: 4` with a `while` loops at most four passes, fewer if the condition goes false first. A parameter the event doesn't have (or `atLeast` on a labelled one) is warned about once and the region loops by its `count`. Decoded and streamed stems release on the same sample.

## Quantised automation

A stem can follow a parameter, like any [event automation](sound-events.md#automation-and-curves), but a music stem can follow it **on the grid**. With `quantize` the stem's level is read at each beat or bar and applied as a short ramp (20 ms) that starts exactly on that grid point, so a layer enters on the downbeat instead of fading in across a bar.

The Sound Lab's `music-intensity` event (`samples/sound-lab/audio/events/music-intensity.audioevent.json`) is the worked example: one 120 bpm segment looping three stems, with a pad that is always there and a pulse and a lead that come in as the global parameter `Intensity` rises.

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

A playlist holds up to 256 children, and playlists may nest. The next child is primed while the current one plays, so a streamed segment is ready in time. The picks are seeded like other random picks: set `audio.seed` in `project.json` to repeat them in a test ([Random seeds for tests](sound-events.md#random-seeds-for-tests)).

**How an advance is entered.** The advance always leaves at the playing segment's exit cue, and the old segment is not faded: its tail rings on under the new one until it ends. What happens at the seam depends on whether you wrote a [transition rule](#transitions) for it:

- **No rule matches** (the playlist has no `transitions`, or none for this pair): the advance is a gapless cut. The next child starts at full level on its entry cue. The default rule's one-beat fade is for changes, not for a playlist's own sequence.
- **A rule you wrote matches**, a `*` to `*` rule included: its `enter`, `fadeIn` and `bridge` apply (its `exit` is ignored, since the advance leaves at the exit cue). To fade every item in, write a `*` to `*` rule with a `fadeIn`.

The Sound Lab's `music-playlist` event is three two-bar segments (explore, calm, combat), two plays each, forever, with no rules: every advance is a cut on the bar line.

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
- A change of the parameter does not cut. It asks for a **transition** from the playing child to the new one, and the [rules](#transitions) say when and how it lands (the next bar, by default).
- If the parameter changes again before the change lands, the latest value wins and two changes inside one bar land once. Setting it back to the playing child cancels the change.
- A value that matches no child is ignored and the playing child plays on. (The default only applies to the first start.)
- Unlike the sound-event `switch` there is no `onChange`. The rules decide.

A switch child may itself be a playlist or another switch.

## The Sound Lab music page

The Sound Lab sample has a music page (key M on its main scene, B goes back; `samples/sound-lab/scripts/behaviors/MusicLab.ts`) that plays five events from `samples/sound-lab/audio/music/`. Every clip is a stem made by `tools/makeMusic.mjs` at 120 bpm in 4/4, so a bar is 2 seconds and any piece can follow any other on the grid. The rest of this page uses it as its example.

| Key | Event | What it shows |
| --- | --- | --- |
| 1, 2, 3 | `music-world`: a `musicSwitch` on the label parameter `State` (explore, combat, calm) | Rules, cut, crossfades and curves, a bridge, stingers |
| T, Y | the same event | A stinger on the next beat (`hit`) and on the next bar (`hitBar`) |
| L | `music-loop`: one segment with a looping region | A tail, and a `while` loop that is released by a parameter |
| P | `music-playlist` | Gapless natural advances |
| 4 | `music-stems8`: one 4 s segment of eight stems that loops, the two melody stems streamed | Eight stems starting on one instant, two of them through music rings |
| 5 | `music-list3`: a playlist of three one-pass 4 s items (A, B, C), once through | Each change on the beat, then the music ends |
| D | | Shows or hides the music health readout: prime lead, prime time, late and held groups (from `Audio.debug().music`) |
| O | | Stops the music |
| B | | Back to the tour |

A row of buttons along the bottom of the view stands in for every key, so the page works on a phone; a button press goes through the same code as its key. Starting one event stops the one before it. The page's label shows the playing segment and position, and the change that is waiting (`handle.music.transition`). The Pending column in the [debug panel's](#the-debug-panels-music-section) Music section names the rule that was chosen.

## Transitions

A change between two segments is a **transition**. A switch asks for one when its parameter moves, and so does anything that changes the target, such as a script setting the parameter. The container's `transitions` list says how. This is the `world` switch's list in `music-world.audioevent.json` (shown here without the default values), and what each pair does when you press 1, 2 or 3:

```json
"transitions": [
  { "from": "explore", "to": "combat", "exit": "bar",
    "fadeOut": { "beats": 0 }, "fadeIn": { "beats": 0 } },
  { "from": "combat", "to": "explore", "exit": "bar",
    "fadeOut": { "beats": 2, "curve": "equalPower" }, "fadeIn": { "beats": 2, "curve": "equalPower" } },
  { "from": "explore", "to": "calm", "exit": "bar",
    "fadeOut": { "beats": 4, "curve": "linear" }, "fadeIn": { "beats": 4, "curve": "linear" } },
  { "from": "calm", "to": "explore", "exit": "bar",
    "fadeOut": { "beats": 4, "curve": "sCurve" }, "fadeIn": { "beats": 4, "curve": "sCurve" } },
  { "from": "calm", "to": "combat", "exit": "bar",
    "fadeOut": { "beats": 1 }, "fadeIn": { "beats": 1 },
    "bridge": { "segment": "riser", "fadeOut": { "beats": 0 }, "fadeIn": { "beats": 0 } } },
  { "from": "*", "to": "*", "exit": "bar" }
]
```

| Change | Rule | What you hear, from the next bar line |
| --- | --- | --- |
| explore to combat | its own, fades of 0 beats | A **cut**: explore stops and combat starts on the same sample |
| combat to explore | its own | A 2-beat **crossfade**, equal power: the loudness stays level |
| explore to calm | its own | A 4-beat crossfade on the `linear` curve: it dips in the middle |
| calm to explore | its own | A 4-beat crossfade on the `sCurve` curve: slow at both ends |
| calm to combat | its own, with a [bridge](#bridges) | A 1-beat crossfade into a one-bar riser, then combat at full level as the riser ends |
| combat to calm | none of its own, so `*` to `*` | The rule's `exit` is `"bar"` and its fades are the defaults: a 1-beat equal-power crossfade |

### The rule

| Field | Values (default) |
| --- | --- |
| `from`, `to` | The `id` of a **direct child** of the container, or `"*"` for any (`"*"`) |
| `exit` | When to leave the playing segment: `"beat"`, `"bar"`, `{ "every": "bar", "n": 2 }` (every n-th, 2 to 64), `"immediate"`, `"nextCue"` or `"exitCue"` (`"bar"`) |
| `enter` | Where to enter the new segment: `"entryCue"` (its entry cue, starting its pickup early), `"sameTime"` (the same musical position, no pickup), or `{ "cue": "name" }` (`"entryCue"`) |
| `fadeOut`, `fadeIn` | `{ beats or seconds, offset?, curve? }`: the fade's length, an optional offset from the exit point (may be negative) and a curve. Default: 1 beat, `equalPower` |
| `bridge` | A segment played between the two, see [Bridges](#bridges) |

**Quantised cut and crossfade.** The change lands on the exit point, on one exact sample. A fade length of 0 is a *cut*: the old segment stops and the new one starts there. A longer fade is a *crossfade*: the old segment's stems fade out and the new ones fade in, both starting at the exit point (use a negative `offset` to start the fade before it). If the exit is `exitCue`, or a grid exit that falls after the exit cue, the change waits for the exit cue and the old segment is not faded; its tail rings on under the new segment until it ends.

**Curves.**
- `linear`: straight ramps.
- `sCurve`: slow at both ends.
- `equalPower`: the default; the two ramps are power-complementary, so the loudness of a crossfade stays constant (`linear` dips in the middle).

The curves run in the audio core, in the voice, on the sample; see [Fades and stops](sound-events.md#fades-and-stops) for how.

**Which rule wins.** The most specific one, in four tiers: both `from` and `to` named, then only `from`, then only `to`, then `*` to `*`. Inside a tier the first listed wins, and the parse warns about a duplicate and about a rule that never wins. Without a `*` to `*` rule the defaults in the table apply. A change between segments under different children of a container, however deep, uses the **nearest common parent's** table, where `from` and `to` name the children that hold the two segments. A dangling `from` or `to` is dropped with a problem. The editor's Transition Rules panel shows the winning rule for every pair and lints the table.

**What the player does.** A change is planned, not reactive: the new segment is loaded and started on the audio thread's clock at the exit point, so a streamed segment is asked for about 100 ms before it (more if loading is slow). A change asked too late for its planned point lands on the next point of the same kind and the debug panel counts a re-plan.

### Bridges

`"bridge": { "segment": "riser", "fadeOut"?, "fadeIn"? }` plays a segment from the container's `library` between the two: the old segment, then the bridge, then the new one. Each seam has its own fades:

| Seam | When | Fades |
| --- | --- | --- |
| Old segment to bridge | The rule's `exit` point on the old segment | The rule's `fadeOut` (old segment) and `fadeIn` (bridge) |
| Bridge to new segment | The bridge's exit cue | The bridge's `fadeOut` (bridge) and `fadeIn` (new segment); each one left out is the rule's |

The bridge enters on its own entry cue (its pickup starts early); the rule's `enter` places the new segment. Unlike an ordinary exit at the exit cue, the bridge's fade-out is applied, so a bridge with audio after its exit cue can crossfade into the new segment.

In the Sound Lab, the calm to combat rule has 1-beat fades and the riser's own fades are 0 beats. So calm fades out over one beat while the one-bar noise riser fades in (the rule's fades), and when the riser reaches its end (it has no exit cue, so that is its exit) combat starts at full level on that exact sample (the bridge's fades). For a riser that should hand over on its last beat, set the bridge's fades to `{ "beats": 0 }` as it does.

Once the old segment's fade has started the change goes through; a change asked after that waits for it and is planned from the new segment.

A bridge under 30 s is decoded and needs no music ring. The new segment is prepared while the bridge plays; if the pool cannot hold it by the time the old segment would start fading, the whole change is refused, the old segment plays on and the log warns once (`poolFull`). A streamed bridge can still go ahead when the pool has room for the bridge and the new segment once the old segment's rings come back and the bridge is long enough to prepare the new segment after that (the old segment's fade, plus about 0.12 s); a shorter one is refused the same way.

## Stingers

A **stinger** is a short sound that plays over the music, exactly on a grid point, without changing the music or its grid. It lives in a `stingers` list on a container, and plays a segment from the container's `library`. These are the Sound Lab's two, which share one segment:

```json
{ "type": "musicSwitch", "id": "world", "parameter": "State", "children": [ /* ... */ ],
  "stingers": [
    { "trigger": "hit",    "segment": "hit", "at": "beat", "dontRepeat": 0.25, "ifTooLate": "nextGrid", "volume": 0.8 },
    { "trigger": "hitBar", "segment": "hit", "at": "bar",  "dontRepeat": 0.25, "ifTooLate": "nextGrid", "volume": 0.8 }
  ],
  "library": [
    { "type": "segment", "id": "riser", "tracks": [ /* ... */ ] },
    { "type": "segment", "id": "hit", "tracks": [{ "name": "hit", "clip": "audio/music/stinger-hit.wav" }] }
  ] }
```

```ts
const accepted = music.trigger("hit");   // false: unknown name, dropped, or refused
```

| Field | Meaning (default) |
| --- | --- |
| `trigger` | The name a script passes to `handle.trigger` (one namespace per event) |
| `segment` | The id of a `library` segment |
| `at` | A grid spec (`"beat"`, `"bar"`, `{ "every": "bar", "n": 2 }`), `"immediate"`, or `{ "cue": "name" }` for the next time the playing segment reaches that cue (`"beat"`) |
| `dontRepeat` | Seconds during which the same stinger is not played again (0) |
| `ifTooLate` | When the point has already passed: `"nextGrid"` plays at the next one (default, with a warning), `"playNow"`, `"skip"` |
| `volume`, `bus` | Override the stinger segment's gain and bus |

- **`library`** holds the segments that stingers and bridges use. They are not children of the playlist or switch. Up to 64 per event.
- With several stingers of the same trigger name, the one on the deepest container above the playing segment wins, then the first listed.
- At most **4 stingers sound at once** per instance; a fifth steals the oldest with a 5 ms fade.
- Keep stinger segments short and decoded (under 30 s): a streamed stinger takes a music ring for as long as it plays.
- `trigger` returns `true` when the stinger is accepted. It returns `false` for an unknown name, when `dontRepeat` or `ifTooLate: "skip"` drops it, when the pool has no ring for a streamed one, and before the music has started.

## Streaming versus decoding

Every stem is either **decoded** (the whole clip is decoded into memory before it plays) or **streamed** (read from the file as it plays, through a *music ring*, a buffer in the audio core).

- A stem **30 seconds or shorter is decoded**; a longer one is **streamed**. This is automatic, by the clip's length. Where the length is not known yet the clip's [import setting](playing-sound.md#sound-files) `stream` decides.
- Streaming keeps memory low but needs a ring, and a start has to be asked for early so the ring is full in time. Decoding costs memory but starts instantly and costs no ring.
- The flappy sample's `town.mp3` is about 80 seconds, so it streams; the Sound Lab's stems are decoded.

**`music.rings`** is the number of music rings, 0 to 16, in `project.json`:

```json
"audio": { "music": { "rings": 12 } }
```

Each streamed stem sounding, or being prepared for the next change, uses one ring (about 300 KB each). The default is 12; the voice presets are **low 8, default 12, high 16**. Music rings are part of the preset's voice budget, not an addition to it. It is also in Project Settings > Audio > Playback > Music, where the voice presets set it. With 0 streamed stems are refused with a warning, and decoded ones still play.

Count the rings you need at the busiest moment: all the streamed stems of the playing segment, plus those of the next one while it is being prepared (a crossfade has both). A segment of 4 streamed stems changing to another of 4 needs 8. If the pool cannot hold the change, the segment is refused and the debug panel says `poolFull`, or `neverFits` when it can never fit (the lint says "needs N rings; this preset has M" before you play). Either keep some stems under 30 s, merge stems, or raise the number.

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
music.trigger("hit");                 // fire a stinger
```

Everything is exported from `"myco"` (`GridSpec`, `GridPoint`, `MusicHandle`, `MusicEvent`, `MusicKind`, `MusicPositionAt`, `MusicSeekResult`, `AudioLatency`, `CalibrationResult`, `Calibration`, and the debug types `MusicDebugRow`, `MusicDebugPending`, `MusicDebugState`, `MusicDebugTotals`). Every member, type and default is listed in the [API reference](interactive-music-api.md).

| Member | What it does |
| --- | --- |
| `handle.music` | The music state, or `undefined` for a non-music handle (never an empty object) |
| `music.segment`, `bar`, `beat`, `beatFraction`, `tempo`, `beatsPerBar`, `beatUnit` | Where the music is **as it is heard**, not as it is scheduled. `segment` is `null` while the first segment is still being prepared, and then `bar` and `beat` read 1 and `tempo` 0 |
| `music.time` | The heard time in seconds of that position, on `Audio.time`'s clock |
| `music.transition` | The pending change, with the heard time it lands: `{ to, time }`, or `null` |
| `music.nextGrid(spec)` | The next beat, bar or n-th bar line at or after now, as `{ time, bar, beat, segment }`. While a change is pending, points after `transition.time` belong to the *new* segment (`segment` says which). `null` when not playing or when nothing follows the exit |
| `music.positionAt(performance.now())` | Where the music was heard at an input's timestamp, see [Judging input](#judging-input) |
| `music.seek(position)` | Jump to a position in the segment that is playing, see [Seeking](#seeking) |
| `handle.trigger(name)` | Fire a [stinger](#stingers); `true` if accepted |
| `handle.setParameter(name, value)` | Drives a [switch](#music-switches) and stem automation, as for every event |
| `handle.stop(fade)`, `handle.fade(to, seconds)`, `handle.release()` | As for every event handle. `stop(fade)` fades all stems at once and is not quantised |
| `Audio.horizon` | Seconds, the earliest heard time at which a *stamped start of a decoded clip* is exact (now plus the audio core's lookahead). Not a promise for a streamed clip |
| `Audio.timeAt(performance.now())` | The heard time of a `performance.now()` instant, such as an input's `event.timeStamp`. Raw: no calibration is applied |

`at` in `Audio.play` is the heard time the *entry cue* is heard; the pickup starts earlier. An `at` closer than the time the player needs to prepare starts at the earliest possible moment instead. Nothing is a grid before the first segment: that moment becomes bar 1 of the grid and every later change lands on it.

`nextGrid` is how a script lines something up with the music, for example a visual flash on the next bar:

```ts
const next = music.music?.nextGrid("bar");
if (next) flashAt(next.time - Audio.time);   // seconds from now
```

An `AudioSource` plays a music event like any event (the flappy sample does). Its `loop`, `spatial` and distance fields are ignored for music, and `pitch` is ignored with a warning.

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
- Refusals: `invalid` (not a position, a beat the bar does not have, or no playable track), `notPlaying` (stopping, stopped or refused) and `neverFits` (the segment can never hold two sets of streaming slots on this preset) are permanent. `poolFull` (no free slots now) is temporary, and so is `notPlaying` before the first segment has started sounding; call again on a later frame. A refused seek did not happen and leaves nothing planned, though a pending change it would have replaced is gone.

### Judging input

```ts
// In an input handler: event.timeStamp is a performance.now() time.
const p = music.positionAt(event.timeStamp);
if (p.segment !== null) {
  const err = p.judged;                          // seconds, + late, - early
  if (Math.abs(err) < 0.05) hit(p.bar, p.beat);  // within 50 ms of a beat
}
```

`positionAt` returns `{ segment, bar, beat, beatFraction, nearestBeatTime, offset, judged }`. `offset` is seconds from the nearest beat that is actually heard, positive when late, raw. `judged` is `offset - Audio.calibration`, the number a rhythm game compares. `segment` is `null` (the rest 0) when the music is not sounding at that instant.

The input is mapped to heard time with `Audio.timeAt` (raw, already counting the output latency), then read on the music's grid. The result follows the music across tempo and metre changes and across a change of segment: from the heard landing of a change on, the position is the new segment's. The nearest beat is one that is actually heard: a beat of the old segment that a change cuts off is not offered, and the new segment's first beat is. Before a segment's first bar (its pickup) `bar` and `beat` read 1 and 1, as `music.bar` does, while `offset` is still against the pickup's own beats.

The position is kept for the playing segment and its pending successor only, so ask about a recent input (a frame or two old, as an event's timestamp is), not about a time before the last change landed. `Audio.calibration` is 0 until you set one (see [Rhythm mode and calibration](#rhythm-mode-and-calibration)), so until then `judged` equals `offset`.

### Beat, bar and cue callbacks

A `GameBehavior` on the same node as the `AudioSource` that plays the music (or on that source's owner node) defines the hooks it wants; defining one is the subscription, and music nobody listens to costs nothing.

```ts
import { GameBehavior, behavior, type MusicEvent } from "myco";

@behavior("game.Pulse")
export class Pulse extends GameBehavior {
  onMusicBeat(e: MusicEvent) { this.transform.scale = 1.2; }
  onMusicBar(e: MusicEvent) { /* e.beat is 1 */ }
  onMusicCue(e: MusicEvent) { if (e.cue === "drop") this.flash(); }
  private flash() { /* ... */ }
}
```

- They run in the update phase just before `update`, in the frame whose window holds the beat's heard time, so `e.heardIn` (seconds until it is heard, `e.time - Audio.time`) is under one frame: schedule the visible response for that moment. It is not negative, except in a call that carries `missed`.
- **`e` is one object per kind, reused for every call.** It is valid only during the call: read it, copy the fields you need, and don't keep it. Nothing is allocated per beat.
- **No backlog.** A hook that is defined or enabled mid-play hears the beats from then on, not the ones before. A disabled behavior is not called, and enabling it again does not replay what it missed.
- **A hitch coalesces.** After a gap longer than a beat (a stalled frame, a hidden tab, a rhythm-mode rebuild) the beats of that kind arrive as **one** call, for the latest, with `e.missed` set to how many others were folded into it (0 normally). A cue call also names the cues that were skipped, in `e.skippedCues`. A seek fires nothing for the span it skips.
- A hook that throws is logged and the others still run.
- The fields are `segment`, `bar`, `beat` (a bar event has beat 1), `cue` (cue events only), `tempo`, `beatsPerBar`, `time`, `heardIn`, `missed` and `skippedCues`; `e.handle` is the handle `Audio.play` returned for this music, so `e.handle.music` and `e.handle.trigger(...)` work in a hook.

### Callbacks for music started with `Audio.play`

Music started with `Audio.play` has no node, so the component hooks never hear it. `handle.onMusic(kind, fn)` is the same subscription for a script: `kind` is `"beat"`, `"bar"` or `"cue"`, `fn` gets the same reused `MusicEvent`, and the call returns a function that unsubscribes.

```ts
import { Audio, GameBehavior, behavior, type AudioEventHandle } from "myco";

@behavior("game.BeatCounter")
export class BeatCounter extends GameBehavior {
  private music: AudioEventHandle | null = null;
  private off: (() => void) | null = null;
  beats = 0;

  start() {
    this.music = Audio.play("music/combat.audioevent.json");
    this.off = this.music.onMusic("beat", (e) => { this.beats += 1 + e.missed; });
  }
  onDestroy() { this.off?.(); this.music?.stop(0.2); }
}
```

- Calls come in the same frame and with the same `missed` coalescing as the component hooks, after them, in the order the listeners subscribed.
- **Unsubscribing** inside a callback lets the current call finish and skips that listener from the next event on. A listener added inside a callback hears the next event, not this one. Subscribing the same function twice calls it twice, and each returned function removes one subscription.
- A kind nobody listens to costs nothing; the first listener of a kind, like a hook gained mid-play, is owed no backlog.
- When the music ends its listeners are dropped. On a handle that is not music, `onMusic` returns a function that does nothing.

### Rhythm mode and calibration

A rhythm game judges the player's taps against the music, and two delays sit between a tap and what the game reads: the delay from the game's beat to the sound (the output latency), and the player's own habit of tapping early or late. Rhythm mode and calibration deal with each.

**Rhythm mode.** In **Project Settings > Audio > Playback > Music** tick *Rhythm mode*, or set `"audio": { "rhythmMode": true }` in `project.json`. The audio context is then made with `latencyHint: 0`, the smallest output buffer the browser allows, which lowers the delay between a beat and the sound at the price of battery and, on a slow device, crackle. `Audio.rhythmMode` reads the setting.

- It refuses nothing, and it promises no absolute latency: the browser decides. Read `Audio.latency`; don't assume.
- Changing the setting at run time rebuilds the audio context (at most once a second). The music re-enters on the next bar, in place, and beat callbacks are **held** while it recovers: afterwards they arrive as one call with `missed` set, as after a hitch.
- Without rhythm mode the context uses `"interactive"` and callbacks are not held. Everything below works either way.

**`Audio.latency`** is read-only, in seconds, a new object per read:

```ts
import { Audio } from "myco";

const l = Audio.latency;     // { base, output, limiter, total, reliable }
if (!l.reliable) console.log("output latency unknown: ask the player to calibrate");
```

`base` and `output` are what the context reports (`baseLatency`, `outputLatency`), `limiter` is the limiter's look-ahead, and `total` is their sum. `reliable` is true only when the output figure is live and between 0 and 0.5 seconds. A constant 0, as some browsers give, is never reliable: calibrate instead of trusting the number.

**`Calibration.fromTaps(offsets, { warmup })`** turns a run of taps into a correction. `offsets` are the raw `positionAt(...).offset` values in seconds (positive for a late tap), one per tap.

```ts
import { Audio, Calibration } from "myco";

function applyRun(offsets: number[]): boolean {
  const r = Calibration.fromTaps(offsets);
  if (r.steady) Audio.calibration = r.offset;
  return r.steady;
}
```

| Result | Meaning |
| --- | --- |
| `offset` | The median of the offsets kept (seconds): the player's usual lateness, with the output delay in it |
| `spread` | Their median absolute deviation (seconds), unscaled |
| `confidence` | 0 to 1: `1 - spread / 0.040` (not below 0) times `min(1, used / 16)` |
| `used`, `discarded` | Offsets kept, and offsets dropped (the warm-up and non-finite ones) |
| `steady` | The spread is 40 ms or less **and** at least 8 offsets were kept |

The first `warmup` taps (default 4) are dropped, since people settle into the beat; a non-finite value (a missed tap) is dropped before that count. Too few taps never throw: the result is all zeros and `steady` is false. Apply a result only when it is `steady`, and ask the player to try again otherwise. 20 taps with the default warm-up leave 16, full confidence for the count.

**`Audio.calibration`** (seconds, default 0) is what `judged` subtracts: `judged = offset - Audio.calibration`. Setting it saves it for the current output device (`Storage`, namespace `settings`), so it is still there next session; a non-finite value is ignored. Each output device has its own value. When the context reports a device change, a device calibrated before brings its saved value back; any other keeps the old value and **`Audio.calibrationStale`** turns true. Show the player a "calibrate again" prompt while it is true; setting `Audio.calibration` clears it.

### The Sound Lab rhythm page

The Sound Lab's rhythm page (key R from the tour page, B goes back; `samples/sound-lab/scripts/behaviors/RhythmLab.ts`, scene `samples/sound-lab/scenes/rhythm.scene.json`) puts the above together. Click the game view first (on a phone, the buttons along the bottom stand in for the keys), then:

| Key | What it does |
| --- | --- |
| C | Calibrate: a 120 bpm click track plays; tap SPACE on every click. The first 4 of 20 taps are warm-up, then `Calibration.fromTaps` runs. A steady result is applied and saved; an unsteady one is shown and not applied |
| G | The tap game: a drum and bass loop; SPACE on the beat. Judged by `judged`: within 30 ms is perfect, within 80 ms good, else a miss; the page shows early or late, hits, misses and the streak |
| SPACE | A tap, timed from the `keydown` event's own time stamp rather than the frame's, so a tap is not up to a frame late. A press or touch on the game view is a tap too, timed from the `pointerdown` event |
| X | Resets `Audio.calibration` to 0 |
| O | Stops the music |
| D | Shows or hides the music health readout |
| B | Back to the tour page |

Each tap goes through `handle.music.positionAt(timeStamp)`, which gives `offset` and `judged`; the beat marker is moved by `handle.onMusic("beat", ...)`. The label shows `Audio.calibration`, a STALE note when `Audio.calibrationStale` is true, `Audio.latency` with its `reliable` flag, and whether rhythm mode is on. **Rhythm mode is off in the Sound Lab.** The setting is project-wide and would change the context of every other page, so the sample leaves it off; the calibration and the tap game work without it. Turn it on in Project Settings > Audio to see the difference in `Audio.latency`. The page's state is on `globalThis.__rhythmLab.state()` for tests.

## The Babylon fallback

The Babylon audio fallback backend plays music switches with their rules and fades, quantised stem automation and stingers (decoded clips), with `setTimeout` accuracy rather than sample accuracy. It does not prime, so streamed stems start separately and may drift apart (turn `stream` off on stems there); it plays no loop tails; streamed stems loop whole rather than by region; it skips stem low-pass automation; two overlapping ramps on one stem cut each other short; and it has no music debug rows. Most of these warn once when they are hit.

Beat, bar and cue callbacks and `handle.onMusic` work there, with limits. They come from the main-side clock (`Audio.time`) and are **uncorrected for output latency**: a beat is called when it is scheduled, not when it is heard, though still within a frame. **Rhythm mode is unavailable**: `audio.rhythmMode` logs one warning, the context keeps its default latency, `Audio.latency` reads zeros and is not `reliable`, and callbacks are not held. `Calibration.fromTaps` works, and `Audio.calibration` is saved per output device as on the core backend: the saved value loads when the context starts, and a `sinkchange` on the context or a `devicechange` in the browser re-keys it and can set `Audio.calibrationStale`.

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
| Event, State | The instance and its asset; `priming`, `playing`, `transitioning`, `recovering` or `ending`. A scheduled change does not change it: the row reads `playing` while the current segment plays and the change shows under Pending. `transitioning` is only the span in which two segments are audible together (a crossfade, or a bridge from its start to its end); a cut or a gapless playlist advance never reads it |
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

In the editor this fires when the project saves a file: saving a stem's audio file or the event asset swaps every playing instance that uses it. A change to the event file that leaves the playing segment as it was only replaces the rules, playlists, switches and stingers, which apply at the next decision. A second edit that arrives while a swap is being prepared waits until the first one has started. A game running outside the editor never changes its files, so nothing fires there.

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

- [Interactive music: API reference](interactive-music-api.md): every member, type, format field and limit.
- [Sound events](sound-events.md): the file, parameters, automation curves, `Audio.play`.
- [Playing sound](playing-sound.md) and [Audio mixer](audio-mixer.md): buses, formats, streaming.
- [Why is there no sound?](why-no-sound.md): the debug panel.
- [Listening pass](../design/0166-audio-music/listening-pass.md): the by-ear and real-device checks.
- Design: `docs/decisions/0166-interactive-music-segments-transition-rules-and-a-heard-beat-clock.md` and `0167-interactive-music-design-corrections-and-owner-decisions.md`.
