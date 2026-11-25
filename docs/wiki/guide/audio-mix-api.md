# Audio mix: API reference

The reference for what the audio mix work (ADR 0171, amended by 0172 and 0173) adds to the scripting API and to the `audio` section of `project.json`: the buses' gain readings, loudness, `Audio.capture`, the debug rows, and the settings keys. For how the pieces fit together, read [Audio mixer](audio-mixer.md), [Live mixing and ducking](audio-mixing.md), [Loudness](audio-loudness.md) and [Audio profiler](audio-profiler.md). The music API has its own page, [Interactive music: API reference](interactive-music-api.md).

Conventions:

- Everything in the scripting part is on `Audio` and `Audio.bus(name)`, exported from `"myco"`. `Bus`, `AudioCapture`, `AudioCaptureState`, `AudioCpuDebug`, `AudioMixCaps`, `AudioMixDebug`, `AudioMixSlotDebug` and `AudioRecorderDebug` can be named as types. The loudness types (`BusLoudness`, `LoudnessTargetReading`) are not exported by name: you get them from `Bus.loudness`, and TypeScript infers them.
- Gains are linear multipliers. Loudness is in LUFS, LU or dBTP. A reading that doesn't exist yet is `-Infinity`, never `NaN`.
- Reading allocates nothing per call, except `Audio.debug()`, which copies its state and is for tools, not for a frame loop.

## `Audio`

| Member | Type | Meaning |
| --- | --- | --- |
| `Audio.capture` | `AudioCapture` | Records the mix for the Profiler, [below](#audiocapture) |
| `Audio.take` | `AudioTake` | Records a take: what the game asked of audio plus the profile, for the Studio to replay; see [Audio takes](audio-takes.md#audiotake) |
| `Audio.loudnessTarget` | `string \| null`, read and write | The name of the entry of `audio.loudnessTargets` that every meter checks against. The first entry is the default. Setting `null` selects the first entry. An unknown name warns once and keeps the current one. Changing it is not a meter reset |

```ts
Audio.loudnessTarget = "mobile";
Audio.loudnessTarget;               // "mobile"
```

`Audio.bus(name)`, `Audio.snapshot(name, fadeSeconds?)`, `Audio.clearSnapshot(fadeSeconds?)` and the rest of the mixer calls are in [Audio mixer](audio-mixer.md#scripting).

## `Bus`

`Audio.bus("Music")` returns the same object every time for a name. An unknown name gives an inert bus (`exists` is false, every reading is neutral and every write is ignored) and warns once. A bus you held keeps working after a live rename, with one warning per old name.

### Levels and gain

| Member | Type | Meaning |
| --- | --- | --- |
| `exists` | `boolean` | The project has a bus of this name |
| `volume` | `number`, read and write | The **runtime multiplier**, 0 to 2, default 1, on top of `authoredVolume`. Never written to `project.json`. While a fade runs it reads the fade's current value on the heard clock. A project load (the next Play) resets it |
| `authoredVolume` | `number`, read only | The project's volume for this bus, 0 to 2. Only the editor changes it (Project Settings, the [Mixer panel](audio-mixing.md#the-mixer-panel)) |
| `fadeTo(v, seconds)` | method | Ease `volume` to `v` over `seconds`: one ramp that starts on an exact frame. `0` seconds is the shortest ramp the core allows (5 ms), never an unramped step |
| `effectiveGain` | `number`, read only | The level reaching the speakers from this bus: the product of every gain on it and on every bus above it (authored, runtime, snapshot, monitor control, structural dip, duck and automation) |
| `duckGain` | `number`, read only | The ducking lane alone: 1 when not ducked, down to the lowest rule's `amount` while ducked. On the core, a block old (a few milliseconds); on the Babylon fallback only presence rules duck |
| `peak` | `number`, read only | The newest peak level, linear, decayed for display; 0 while the audio is locked and always 0 on the Babylon fallback |
| `activeVoices` | `number`, read only | Sounds playing on this bus right now |

```ts
const music = Audio.bus("Music");
music.volume = 0.5;                      // half of whatever the project authored
console.log(music.authoredVolume);       // still the project's number, e.g. 0.8
console.log(music.effectiveGain);        // 0.4 x snapshots x ducking x the parent's gain
if (music.duckGain < 1) console.log("music is under the dialogue");
```

### Mute and solo

| Member | Type | Meaning |
| --- | --- | --- |
| `mute` | `boolean`, read and write | The runtime mute, default false. The bus is silent when the authored mute **or** this **or** a monitor control says so |
| `authoredMute` | `boolean`, read only | The project's `mute` for this bus |
| `solo` | `boolean`, read and write | While any bus is soloed, only soloed buses, the buses under them and the buses on the way to them are heard. Default false |

The Mixer panel's **MM** and **S** (monitor mute and solo) are not on `Bus`: they are editor controls that are never saved and that [taint the meters](audio-mixing.md#monitor-controls-and-taint).

### `Bus.loudness`

`bus.loudness` is a stable object per bus: keep it. On a bus the project doesn't meter, on a missing bus and on the Babylon fallback it is the inert reading: `metered` false, every reading `-Infinity`, `elapsed` 0, `target` null, and `reset`, `pause` and `resume` do nothing. None of them throws. Which buses are metered: [Loudness](audio-loudness.md#what-is-measured).

Readings:

| Member | Type | Meaning |
| --- | --- | --- |
| `momentary` | LUFS | The last 0.4 s |
| `shortTerm` | LUFS | The last 3 s |
| `integrated` | LUFS | Gated, since the last reset |
| `lra` | LU | Loudness range; `-Infinity` until two 3 s blocks pass the gates |
| `maxTruePeak` | dBTP | The larger of the 4x-oversampled true peak and the sample peak |
| `truePeakBound` | `"exact" \| "lowerBound"` | `"lowerBound"` when the core skipped true-peak work on quiet stretches: the real peak is at least this high |
| `maxMomentary` | LUFS | The highest momentary reading since the last reset |
| `elapsed` | seconds | Metered time since the last reset (paused, shed and gap time not counted) |

State:

| Member | Type | Meaning |
| --- | --- | --- |
| `metered` | `boolean` | The project meters this bus and the audio core is running |
| `paused`, `pausedBy` | `boolean`, `"script" \| "ladder" \| null` | Metering is stopped, and by whom |
| `incomplete` | `boolean` | A stretch was not measured (a main-thread stall over 3.2 s, a rebuild, or the ladder). Stays until `reset("all")` or `reset("integrated")` |
| `tainted` | `boolean` | A monitor control or Compare changed what this meter heard. Stays until the same resets |
| `target` | `LoudnessTargetReading \| null` | The verdict against `Audio.loudnessTarget`; null when the project has no targets |

Controls:

| Member | Meaning |
| --- | --- |
| `reset(what?)` | `"integrated"`, `"maxPeak"` or `"all"` (the default) |
| `pause()`, `resume()` | Stop and restart measuring this bus |

```ts
const m = Audio.bus("Master").loudness;
m.reset("all");
// ...play a level...
if (m.metered && m.target?.state === "high") console.warn(`${m.target.deviation} LU over`);
if (m.incomplete || m.tainted) console.log("read this number with care");
```

### `LoudnessTargetReading`

`loudness.target` when the project has targets.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | The target in force |
| `integrated` | LUFS | The goal |
| `tolerance` | LU | Plus or minus |
| `truePeak` | dBTP | The ceiling |
| `deviation` | LU | `integrated` minus the goal; `-Infinity` until `integrated` has a value |
| `state` | `"waiting" \| "ok" \| "high" \| "low" \| "suspended"` | `suspended` while a mute, MASTER not 1, a monitor control or Compare means the number would not describe what a player hears |
| `peakOver` | `boolean` | `maxTruePeak` went above `truePeak` |

## `AudioCapture`

`Audio.capture`. Records the mix into a `.sporesample` file the [Audio Profiler](audio-profiler.md) opens. The recorder is a separate chunk loaded by the first `start()`; a game that never calls it loads nothing.

| Member | Type | Meaning |
| --- | --- | --- |
| `state` | `AudioCaptureState` | `"idle"`, `"loading"` (the chunk is loading), `"recording"` or `"stopped"` (a recording exists to save) |
| `seconds`, `bytes` | `number` | What the ring holds; 0 while idle |
| `truncated` | `boolean` | The ring wrapped over the start of the recording; the file begins at a later keyframe and says so |
| `start()` | `Promise<void>` | Load the recorder and begin a recording. Resolves once recording; rejects with a message if the chunk or the core is unavailable. A second `start()` while recording joins the recording, writes a marker and resolves at once |
| `stop()` | `void` | End the recording. The ring keeps recording while the Profiler panel is open |
| `mark(text)` | `void` | A marker on the timeline, cut to 120 UTF-8 bytes. Does nothing while no ring runs |
| `save(name?)` | `Promise<string>` | Compress and save the latest recording. Resolves with the file name (web) or path (app). Rejects with "nothing recorded: call Audio.capture.start() first" when there is none |

`save` keeps letters, digits, `.`, `_` and `-` of `name`, turns other runs into `_`, cuts to 64 characters and adds `.sporesample`. Without a name the file is `capture-YYYYMMDD-HHMMSS.sporesample`. On desktop and Android the app saves `<name>.sporesample` in its data folder's `recordings/` (ADR 0408); auto-named files keep the newest 16. A browser downloads and stops at 16 saves per page session. See [Captures on Android](audio-profiler.md#captures-on-android) for getting a file off a phone.

```ts
await Audio.capture.start();
Audio.capture.mark("boss phase 2");
// ...play...
Audio.capture.stop();
const where = await Audio.capture.save("boss-fight");
```

## `Audio.debug()` additions

`Audio.debug()` copies the audio state for tools and [Why is there no sound?](why-no-sound.md). M5 adds these members. Each is optional in the type: a backend fills what it can.

| Member | Type | Meaning |
| --- | --- | --- |
| `mixCaps` | `AudioMixCaps` | What this backend can do: `loudness`, `levelDucking`, `cpu` (with `cpuReason` when false), `stampedBusRamps`, and `capture` (`"full"`, or `"mainSideOnly"` on the Babylon fallback) |
| `cpu` | `AudioCpuDebug` | Main's load figure: `loadPermille` (`null` before the first window fills, 1000 is a whole block), `windowMs`, `clockStepMs`, `clockSteps`, `refitResidual`, `sections` (an estimated share per part of the core: voices, buses, spatial, music, loudness) and `hidden`, the reason the figure is hidden when the worklet's clock is too coarse |
| `mix` | `AudioMixDebug` | The live mix: `slots` (each bus's core slot and whether it is `live`, a `tombstone` or `free`), `monitorActive`, `metersPaused`, `loudnessLadderStep` (1 while the ladder has paused the meters), `busRecordsEarly`, `sidechainLate`, `liveRefused`, `liveDeferred`, `liveDeferredPending` and `ducking` (each rule's `target`, `trigger`, `mode` and current `gain`) |
| `recorder` | `AudioRecorderDebug \| null` | The shared capture ring: `state`, `owners` (the Profiler panel, `Audio.capture` and the export's trigger each hold it), `bytes`, `segments`, `evicted`, `truncated`; `null` while no ring runs |

The instance rows are the playlist runtime's (ADR 0343): `events` lists the playing playlist instances (`asset` is the playlist path) and `playlistTotals` the refused triggers, steals and late starts. `music` has one row per playing playlist instance whose playing entry has a tempo (a Sequence with one, or a Clip whose sample has one): the segment (the sequence playlist or the sample), bar, beat, tick and tempo heard now, the Switch change waiting for its boundary (`pending`: the label, `"bar:beat"` where it lands, the rule) and the stingers waiting or playing (`groups`, `"stamped"` then `"playing"`); the music players' ring and prime figures stay zero. `musicTotals` carries the music backend's own figures and the stinger outcomes over the session. `handle.music.transition` names the same pending change.

```ts
const d = Audio.debug();
console.log(d.cpu?.loadPermille, d.cpu?.hidden);
console.log(d.mix?.ducking);            // [{ target: "Music", trigger: "Voice", mode: "presence", gain: 0.4 }]
```

## The `audio` section

What a project writes. The full bus model is in [Audio mixer](audio-mixer.md); these are the M5 keys.

| Key | Meaning |
| --- | --- |
| `buses[].meter` | `"loudness"` meters the bus (at most 8 besides `Master`, which is always metered). The only value; not written when off |
| `ducking[].mode` | `"presence"` or `"level"`, required |
| `ducking[].detector` | Level rules only: `"rms"` (default) or `"peak"` |
| `ducking[].threshold` | Level rules only: dBFS, -80 to 0, default -30 |
| `loudnessTargets[]` | 1 to 8 entries of `name`, `integrated` (-70 to 0), `tolerance` (0 to 12, default 2) and `truePeak` (-20 to 0, default -1). Default: `console` (-24 LUFS) and `mobile` (-18 LUFS) |
| `loudnessResetOnPlay` | Default true: every Play resets the meters |

At most 32 ducking rules, at most 8 of them level rules, and no cycle among level rules. The `amount`, `attack` and `release` of a rule, and the snapshot and automation keys, are unchanged; see [Live mixing and ducking](audio-mixing.md#ducking).

An exported game records and saves captures when exported with the **Audio capture** option (`game.json` `audioCapture: true`; `npm run export -- <dir> --audio-capture`). F9, or a one-second three-finger hold, starts and then stops and saves. See [Audio profiler](audio-profiler.md#capturing-from-a-game-script). The **Audio take** option (`game.json` `audioTake: true`; `--audio-take`) does the same for takes on F10; see [Audio takes](audio-takes.md).

## See also

- [Audio mixer](audio-mixer.md), [Live mixing and ducking](audio-mixing.md), [Loudness](audio-loudness.md), [Audio profiler](audio-profiler.md), [Audio takes](audio-takes.md)
- [ADR 0171](../../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md), [0172](../../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md), [0173](../../decisions/0173-the-editor-sdk-lets-a-panel-edit-project-settings-through-the-shared-section.md)
