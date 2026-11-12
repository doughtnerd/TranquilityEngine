# Sound events

An **event** is a sound described in data: "a footstep" instead of `footstep_03.ogg`. It lives in a `*.audioevent.json` file and can pick one of several clips at random, play clips in order, switch on a surface, blend by speed, layer sounds, or loop until you let go of a key. A sound designer can change it without touching code, and a script plays it by name:

```ts
import { Audio } from "myco";

Audio.play("audio/footstep.audioevent.json", { parameters: { Surface: "Gravel" } });
```

Events play through the same [mixer buses](audio-mixer.md), voices, priorities and handles as [other sounds](playing-sound.md). Nothing plays until the player has clicked or pressed a key once; see [Why is there no sound?](why-no-sound.md).

**Use an event** when a sound has variation (random clips, pitch or volume), more than one part (layers, a start, a loop and an end), or responds to a value in the game (speed, surface, danger). **Use `Audio.playOneShot`** for a single clip played as it is. `Audio.play` also takes a plain clip path and plays it as a one-clip event, so you can start with a clip and turn it into an event later.

## The file

A minimal event, one clip with a little random pitch:

```json
{
  "format": "myco.audioevent@1",
  "bus": "SFX",
  "pitchRandom": [-1, 1],
  "root": { "type": "clip", "clip": "audio/coin.wav" }
}
```

A fuller one, footsteps that get louder with speed:

```json
{
  "format": "myco.audioevent@1",
  "bus": "SFX",
  "volume": 1,
  "pitch": 1,
  "volumeRandom": [-2, 0],
  "pitchRandom": [-1, 1],
  "priority": 128,
  "spatial": { "minDistance": 1, "maxDistance": 30, "rolloff": "inverse" },
  "limit": { "maxInstances": 4, "steal": "oldest" },
  "cooldown": 0.05,
  "parameters": [{ "name": "Speed", "min": 0, "max": 10, "default": 0, "seekSpeed": 20 }],
  "automation": [{ "parameter": "Speed", "target": "volume", "curve": [[0, 0.5], [10, 1]] }],
  "root": {
    "type": "random", "avoidRepeat": 2,
    "children": [
      { "type": "clip", "clip": "audio/step_01.ogg", "weight": 1 },
      { "type": "clip", "clip": "audio/step_02.ogg" },
      { "type": "clip", "clip": "audio/step_03.ogg" }
    ]
  }
}
```

Everything except `root` is optional. Clip paths are asset paths, and they follow the file when you rename a clip in the editor.

| Field | Meaning (default) |
| --- | --- |
| `bus` | The mixer bus; empty is Master. An unknown name plays on Master with a warning |
| `volume`, `pitch` | Base multipliers (1) |
| `volumeRandom` | dB added per play, uniform in `[low, high]` (`[0, 0]`) |
| `pitchRandom` | Semitones added per play, uniform in `[low, high]` (`[0, 0]`) |
| `priority` | 0 to 255 (128); a higher value is kept longer when a voice limit is hit |
| `spatial` | `minDistance`, `maxDistance`, `rolloff` (`linear`, `inverse`, `exponential`), and `occlusion` (default true), `dopplerLevel` (0 to 5, default 0) and `reverbSendCurve` ([Spatial audio](spatial-audio.md)). Left out: the event plays flat. `"enabled": false` also means flat |
| `filter` | `lowpass` and `highpass` in Hz, applied to each voice of the event ([Sends and filters](#sends-and-filters)) |
| `sends` | `reverb` (0 to 2, default 1) and at most one other key naming a bus ([Sends and filters](#sends-and-filters)) |
| `limit`, `cooldown` | [Limits and cooldown](#limits-and-cooldown) |
| `parameters`, `automation` | [Parameters](#parameters) and [automation](#automation-and-curves) |
| `root` | The container tree |

The file is read leniently. A wrong value is replaced by its default, an unknown node type is dropped, and each problem is written once to the console as `[myco] <path>: ...`, so a typo never throws and never silences the rest of the event.

## Sends and filters

Two optional blocks shape a voice after it is positioned (ADR 0162). A flat event ignores the spatial keys, but `filter` and `sends.<bus>` still apply to it.

```json
"spatial": { "minDistance": 1, "maxDistance": 30, "occlusion": true, "dopplerLevel": 0, "reverbSendCurve": [[0, 1], [1, 0.5]] },
"filter": { "lowpass": 9000, "highpass": 80 },
"sends": { "reverb": 0.5, "Cave": 0.3 }
```

- `filter.lowpass` and `filter.highpass` (10 to 24,000 Hz) cut the high or low tones of every voice of the event. A low-pass at 20,000 Hz or more, or a high-pass at 20 Hz or less, is off. When several things low-pass a voice (a wall, automation, the bus, a snapshot) the **lowest cutoff wins**; the Audio Debug panel's `lowpassBy` says which.
- `sends.reverb` is how much of the event goes to the reverb zones that hold it (the `reverbSend` of an `AudioSource`). Any other key is an **aux send**: a copy of the voice into that bus (after the voice's own bus gain), so one sound can feed an echo or a radio effect bus. **One aux send per voice**: if you list more, the first in file order is used and the parse reports the rest. An unknown bus is dropped with a problem when the event plays.
- `spatial.dopplerLevel` defaults to 0 on an event, unlike an `AudioSource`'s 1, and an `AudioSource` playing the event does not override it.

## Containers

`root` is a tree of nodes. Every node can also carry `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `delay` (seconds before it starts) and its own `automation`. A tree may have up to 1,024 nodes and nest 16 deep; more are dropped with a problem.

### clip

Plays one asset.

```json
{ "type": "clip", "clip": "audio/wind.ogg", "loop": true, "startOffset": 0.5 }
```

`loop` repeats the clip, `startOffset` starts it that many seconds in. `loopRegion: [start, end]` (seconds) loops only that part of the clip, from `end` back to `start`. Use it with `loop: true`, or with `sustain`:

```json
{ "type": "clip", "clip": "audio/engine.ogg", "loopRegion": [0.4, 2.1], "sustain": true }
```

With `"sustain": true` the clip loops until the instance is [released](#scripting), then plays on through the rest of the clip (its tail) and ends. Without a `loopRegion` it loops the clip's own [loop points](#loop-points) (the sidecar's, else the file's), and the whole clip if it has none.

### random

Picks one child by `weight` (default 1).

```json
{ "type": "random", "avoidRepeat": 2, "children": [
  { "type": "clip", "clip": "audio/hit_a.wav", "weight": 3 },
  { "type": "clip", "clip": "audio/hit_b.wav" },
  { "type": "clip", "clip": "audio/hit_c.wav" }
] }
```

`avoidRepeat: n` skips the last `n` picks (0, the default, bans nothing; it is capped at one less than the number of children). `mode` is `"step"` (default: one pick per play) or `"continuous"`: keep picking back to back until the instance is stopped. In continuous mode `gap` is the seconds between one pick's end and the next's start; a negative `gap` overlaps them with a crossfade.

### sequence

Plays children in order.

```json
{ "type": "sequence", "mode": "step", "reset": 2, "children": [
  { "type": "clip", "clip": "audio/combo_1.wav" },
  { "type": "clip", "clip": "audio/combo_2.wav" },
  { "type": "clip", "clip": "audio/combo_3.wav" }
] }
```

In `"step"` mode each play advances one child. The position is kept per event asset, per [World](worlds.md), and `reset` goes back to the first child after that many idle seconds (0, the default, never). In `"continuous"` mode the children play back to back (with `gap`, as in random), and `loop: true` starts over after the last one.

### switch

Plays the child whose `value` matches a **labelled** parameter, else the child whose `value` is the `default` label (else the first child).

```json
{ "type": "switch", "parameter": "Surface", "default": "Grass", "onChange": "crossfade", "crossfade": 0.2, "children": [
  { "type": "clip", "clip": "audio/step_grass.ogg", "value": "Grass" },
  { "type": "clip", "clip": "audio/step_gravel.ogg", "value": "Gravel" }
] }
```

`onChange` says what a parameter change does to a sound that is already playing: `"keep"` (default) leaves it, `"restart"` switches to the new child at once, `"crossfade"` fades to it over `crossfade` seconds (default 0.1).

### blend

Plays all children at once, each one audible only around its own range of a parameter, so a sound can change smoothly with a value.

```json
{ "type": "blend", "parameter": "RPM", "children": [
  { "type": "clip", "clip": "audio/engine_low.ogg",  "loop": true, "range": [0, 3000],    "fade": 1000 },
  { "type": "clip", "clip": "audio/engine_high.ogg", "loop": true, "range": [4000, 8000], "fade": 1000 }
] }
```

Each child has a `range: [low, high]` where it is at full level, and a `fade` width in parameter units on each side where it fades in and out (about equal power; 0 is a hard edge). A child outside its range keeps running silently, so the children stay in time with each other. A child without a `range` plays at every value (and the parser says so).

### layer

Plays all children together.

```json
{ "type": "layer", "children": [
  { "type": "clip", "clip": "audio/explosion_boom.wav" },
  { "type": "clip", "clip": "audio/explosion_debris.wav", "delay": 0.15 }
] }
```

### sustain

For sounds authored as separate files: an optional `start`, a `loop` and an optional `end`. Each slot holds any node, so the loop can itself be a random or a blend container.

```json
{ "type": "sustain", "release": "loopEnd",
  "start": { "type": "clip", "clip": "audio/saw_start.wav" },
  "loop":  { "type": "clip", "clip": "audio/saw_loop.wav" },
  "end":   { "type": "clip", "clip": "audio/saw_end.wav" } }
```

`start` then `loop` play back to back with no gap, and `loop` repeats until the instance is released. On release, `end` plays: with `"release": "loopEnd"` (the default) when the current pass of the loop finishes, to the sample; with `"release": "now"` right away, crossfading over `releaseFade` seconds (or `fade` when `releaseFade` is absent; a sustain that is itself a blend child keeps `fade` for its blend edges and sets `releaseFade` for the release).

## The Event editor

Double-click a `*.audioevent.json` in the Assets panel (or right-click an empty area, **New Event**, then double-click the new file) to open it in the Audio Event panel.

- **Containers.** The tree on the left shows the event, then its nodes. Pick a container and choose **Add** to put a node at its end (or beside a node that isn't a container). **Wrap in** puts the selection inside a new container; **Change type** swaps a list container's type. Alt+Up and Alt+Down reorder, Ctrl+D duplicates, Delete removes, and rows drag to a new place.
- **Clips.** Drag clips from the Assets panel onto the tree; the drag label says what releasing does: add to a container or a sustain slot, or replace a clip.
- **Properties.** The right side shows the selected node's fields (weight, volume, loop and so on), or the event's own: bus, levels, randoms, priority, spatial, limit, cooldown and automation. Add an automation to drive volume, pitch or low-pass from a parameter, then drag the curve's keys.
- **Parameters.** **+ Parameter** adds a local parameter, numeric or labelled. Local names win over project ones. Each parameter has a slider (or label buttons) for auditioning; those values aren't saved.
- **Undo.** Edits save after a short pause. Ctrl+Z and Ctrl+Shift+Z, the Undo and Redo buttons and the History panel act on the open event; a slider or curve drag is one step.
- **Audition.** **Play** runs the event through the editor's audio host with the slider values, **Release** sends the key-off and **Stop** ends it. The voice table lists the instance's voices. If you edit the event while it plays, a note says so: press Play again to hear the change.

## Parameters

A parameter is a named value that your game sets and the event reacts to. A **numeric** one has `min`, `max`, `default` and `seekSpeed`; a **labelled** one has `labels` and a `default` label.

- **Local** parameters are declared in the event's `parameters` (up to 16), and each playing instance has its own value. Use them for per-sound values: a speed, a charge level.
- **Global** parameters are declared in the project's `audio.parameters` in `project.json` (up to 64) and are shared by every event and bus. Use them for the state of the game: `Intensity`, or `Area` with labels `["Outdoor", "Cave", "Hall"]`. A labelled global parameter is what other engines call a state; there is no separate state system.

```json
"parameters": [
  { "name": "Intensity", "min": 0, "max": 1, "default": 0, "seekSpeed": 0 },
  { "name": "Area", "labels": ["Outdoor", "Cave", "Hall"], "default": "Outdoor" }
]
```

`seekSpeed` is how many units per second the value moves toward a new one (0 jumps at once). It smooths changes so automation does not click: with `seekSpeed: 20`, a speed set from 0 to 10 takes half a second to get there. Labelled parameters always jump. Set labelled values by label (`"Cave"`); in a curve or a blend, a label is its index (`Outdoor` is 0, `Cave` is 1).

A name that is neither the event's nor a global parameter, a label that does not exist, and a non-number each warn once; the value is clamped or ignored.

Project Settings > Audio has a Parameters section (numeric or labelled) and an Automation section (a bus, a target, a global parameter and the curve, edited with the curve widget); both write `audio.parameters` and `audio.automation` in `project.json`.

## Automation and curves

Automation makes a parameter drive a property through a curve. List it on the event or on any node:

```json
"automation": [
  { "parameter": "Speed",  "target": "volume",  "curve": [[0, 0.5], [10, 1]] },
  { "parameter": "Speed",  "target": "pitch",   "curve": [[0, 0.9], [10, 1.2, "smooth"]] },
  { "parameter": "Danger", "target": "lowpass", "curve": [[0, 20000], [1, 800]] }
]
```

| Target | Is | Notes |
| --- | --- | --- |
| `volume` | Linear gain | Multiplies the event's and node's own volume |
| `pitch` | Ratio | Multiplies their pitch |
| `lowpass` | Cutoff in Hz | The lowest of several wins. Needs the audio core: [the Babylon fallback](#what-the-babylon-fallback-cant-do) ignores it |

On the audio core the smoothing and the curves run in the audio thread every 2.67 ms, so automation is smooth whatever the frame rate, and a steady event costs the game's thread nothing per frame.

**Bus automation** drives a bus from a global parameter. It goes in the `audio` section of `project.json`, and multiplies with snapshots and ducking instead of replacing them. Targets are the bus's `volume` and `lowpass`; only global parameters can drive a bus.

```json
"audio": {
  "parameters": [{ "name": "Intensity", "min": 0, "max": 1, "default": 0, "seekSpeed": 2 }],
  "automation": [
    { "bus": "Music", "parameter": "Intensity", "target": "volume", "curve": [[0, 0.4], [1, 1]] }
  ]
}
```

### Curve keys

A curve is a list of keys, `[x, y]` or `[x, y, shape]`. `x` is the parameter's value, `y` what the target becomes. Keys go in order of `x` (they are sorted if not). Before the first key the value is the first key's `y`, after the last key it is the last key's. A key's `shape` is how the curve travels from it to the next key:

| Shape | Travels |
| --- | --- |
| `linear` (default) | In a straight line |
| `step` | Holds `y` until the next key, then jumps |
| `smooth` | Smoothstep: eases in and out |
| `easeIn` | Starts slowly (quadratic) |
| `easeOut` | Ends slowly (quadratic) |

A curve has at most 32 keys; extra keys are dropped with a problem. Particle curves (`[t, v]`, linear) are valid curves too.

## Scripting

```ts
import { Audio, AudioSource } from "myco";

// Play: returns a handle. A refused play (cooldown, full limit, missing asset) returns an inert one.
const engine = Audio.play("audio/engine.audioevent.json", {
  parameters: { RPM: 1200 },      // initial local parameters
  position: car.worldPosition,    // a spatial event; flat events ignore it
  volume: 0.8, pitch: 1,          // multiply the event's own
  bus: "SFX", priority: 200,      // override the event's
  at: Audio.time + 0.5,           // an exact start time, as for playOneShot
});

engine.setParameter("RPM", 5400);        // this instance's local parameter
engine.getParameter("RPM");              // 5400
engine.position = car.worldPosition;     // move a spatial instance; null when flat
engine.release();                        // key-off: sustain loops play their tails
engine.fade(0.3, 1);                     // the same handle members as playOneShot's
engine.stop(0.5);
engine.playing; engine.reason;

Audio.setParameter("Area", "Cave");      // a global parameter, by label for a labelled one
Audio.getParameter("Intensity");
```

`Audio.play` never throws. `handle.playing` stays `true` until the last voice of the instance ends; completion is polled, as for every handle. A continuous event plays until stopped, and `stop(fade)` fades out every voice of the instance.

`release()` makes every `sustain` clip and container in the instance leave its loop and play its tail. Sounds without sustain are unaffected, the instance ends when its last voice ends, and releasing twice, or an instance with nothing to release, does nothing.

`handle.setParameter` sets the event's local parameters. A global name warns and points you at `Audio.setParameter`.

### AudioSource

An `AudioSource` accepts an event in `clip` (the Inspector's picker offers clips and events). It plays as an instance that follows the node. `volume` and `pitch` apply on top of the event's; `loop`, `spatial` and the distance fields come from the event, and `output` and `priority` override the event's `bus` and `priority` when the source starts. It also has `setParameter`, `getParameter` and `release()`, which do nothing for a plain clip.

```ts
const source = this.node.getBehavior(AudioSource)!;
source.clip = "audio/engine.audioevent.json";
source.play();
source.setParameter("RPM", 3000);
source.release();
```

## Loop points

Sounds that loop inside a file, such as an engine hum with an attack before the loop, need a loop region. Set it in the event with `loopRegion` on a `clip` node (above), or store it with the clip. On the audio core, clips held in memory and streamed clips both honour it.

A clip's own loop points come from its sidecar (`<asset>.meta.json`: `loopStart` and `loopEnd` in seconds), else from the file: a WAV `smpl` chunk or Ogg Vorbis `LOOPSTART` and `LOOPLENGTH` comments. An event `clip` without a `loopRegion` uses them, and so does a plain looping `AudioSource` (or `playOneShot` with `loop`); a clip with no points loops whole, as before. To keep a whole-clip loop for a clip that has points, set a sidecar `loopStart: 0` and `loopEnd` to the clip's length. Ogg Opus comments are not read, because [Opus is not supported](playing-sound.md#sound-files). On the Babylon fallback, reading a clip's points fetches the file once more, and streamed clips loop whole.

## Limits and cooldown

`limit` caps how many instances of one event play at once:

```json
"limit": { "maxInstances": 4, "steal": "oldest" }
```

`maxInstances` 0 (the default) is unlimited. When a new play would pass the cap, `steal` decides: `"oldest"` stops the oldest instance (default), `"quietest"` stops the quietest, `"none"` refuses the new play. `cooldown` (seconds, up to 60) refuses a play that comes sooner than that after the last one, which keeps a collision that fires every frame from machine-gunning. A refused play returns an inert handle. These apply to whole instances; the usual voice priorities and limits still apply to each voice inside ([Playing sound](playing-sound.md), [the mixer](audio-mixer.md)).

## Random seeds for tests

Random picks, and random pitch and volume, differ each run. To make them repeat, set `audio.seed` (a whole number) in `project.json`:

```json
"audio": { "seed": 1234 }
```

Each [World](worlds.md) gets its own generator derived from the seed, so a test running two Worlds gets the same picks whatever the other one plays. Leave it out for a new seed every run.

## What the Babylon fallback can't do

On the Babylon fallback ([which backend plays](playing-sound.md#which-backend-plays)) events play, with these differences:

- **No per-voice low-pass.** `lowpass` automation, the `filter` block and a one-shot's `lowpass` and `highpass` are ignored, with one warning per asset.
- **No aux sends** (`sends.<bus>`), with one warning per asset. `sends.reverb` does nothing there, because reverb zones are inert on the fallback.
- **Occlusion lowers the volume only** (no low-pass), and **Doppler** changes the playback rate of decoded clips only (a streamed clip gets none). More in [Spatial audio](spatial-audio.md#the-babylon-fallback).
- **Streamed clips loop whole.** A clip with `stream` on cannot loop a region there; it loops the whole clip, with one warning. Keep clips that need a `loopRegion` or `sustain` out of `stream`.
- Parameters, curves and blends are calculated once per frame on the game's thread instead of in the audio core, so automation steps at the frame rate rather than every 2.67 ms.
- The Audio Debug panel lists only the voices that belong to events.

## Fades and stops

`handle.fade(to, seconds)` and `handle.stop(fadeSeconds)` are the same on an event handle as on every other handle: they start as soon as the call reaches the audio core, and the fade is **linear**. The public handle has no start time and no fade law.

What the engine does for a *stamped* fade or stop, one with a start time on the audio clock, is used by the interactive-music system (transitions, stingers, reloads) rather than by a script call:

- It lands on its own sample. The audio core applies it inside the one voice it targets, so it doesn't cut the other voices' blocks short or cost them anything. Gain and stop records do it with a compare against the record's start sample; a record that changes something else of that voice (pitch, a low-pass, a loop) renders only that voice in two pieces.
- Records that aren't about one voice (bus mixes, master, listener, configuration) still split the block of 128 frames for every voice.
- The fade laws are `linear`, `sCurve` and `equalPowerIn` / `equalPowerOut`. They are not a script option: they are the internal `ShapedFade` (`src/plugins/audio/runtime/backend.ts`), and music rules reach them through a transition's `curve`.

Caveats:

- A law runs at control rate: the voice's linear ramp is re-aimed at the law's value at the start sample and again at every 128-frame block, so a curved fade is a chain of short straight segments. The error against the exact curve is below audibility, and a crossfade of `equalPower` fades keeps its power constant.
- At most 255 shaped fades run at once. Past that a new one fades linearly and counts in `Audio.debug().musicTotals.curvePoolFull`.
- On the Babylon fallback (no audio core) a stamped fade is approximated by main-thread timers and steps of the voice's volume: it is not sample-exact.
- `Audio.debug().musicTotals.splitQuanta` counts blocks split for every voice and `voiceSplits` counts splits of one voice. Music keeps `splitQuanta` at 0; `voiceSplits` is informational.

## The Audio Debug panel

The Audio Debug panel groups the voices of an event instance under one row, with the event's path and its parameters' current values, so a layered or blended sound reads as one thing. It also counts the clips of continuous containers that started a frame late (their length was not known yet when the next one had to be scheduled); a steady non-zero count means a clip is loading or streaming too slowly. `Audio.debug().events` holds the same rows for tools, and each voice row has an `event` field, the instance id or null.

## Caps and what to do

| Cap | Limit | When you hit it |
| --- | --- | --- |
| Automation curves | 1,024 in use over the whole run; curves are never freed | One warning, and curves past the cap are ignored. Every automation entry and every blend child with a `range` uses one. Use fewer entries and blend children, and avoid reloading edited events again and again in one run |
| Global parameters | 64 | The extra ones are dropped with a problem. Merge parameters, or make a rarely used one local |
| Local parameters per event | 16 | The extra ones are dropped with a problem. Split the event |
| Automation bindings per voice | 8 | The rest are ignored, with a warning naming the event. Move some automation up or down to a node whose voices need fewer |
| Simultaneous instances | 1,024 | Further ones play without local parameters, with one warning. Put a `limit` on frequent events |
| Keys per curve | 32 | Extra keys are dropped. Use a `shape` instead of more keys |

