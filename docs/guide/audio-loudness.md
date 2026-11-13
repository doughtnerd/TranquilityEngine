# Loudness, targets and `Bus.loudness` (ADR 0171, amended by 0172)

A mix can be well balanced and still too loud or too quiet next to other games. The audio core measures **loudness** the way broadcast does (ITU-R BS.1770 / EBU R 128) and shows it in the Mixer panel, in the [Audio Profiler](audio-profiler.md) and to your scripts. It compares the result with a **target** for your platform. It **warns and never adjusts**: nothing here touches a fader, a bus or the master volume. For buses, see [Audio mixer](audio-mixer.md).

Loudness metering needs the audio core (`audio.backend` `"core"`). On the Babylon fallback no bus is metered: every `loudness` reads as unmetered (below).

## What is measured

Each meter reports, in LUFS unless noted:

- **M, momentary**: the last 0.4 s. **S, short-term**: the last 3 s.
- **I, integrated**: the whole run since the last reset, gated so silence and quiet gaps don't pull it down (the standard's -70 LUFS gate, then a gate 10 LU under the average of what passed).
- **LRA**, loudness range in LU: how much the level moves, from short-term blocks (20 LU relative gate).
- **True peak** in dBTP: the highest peak after 4x oversampling, so it catches peaks between samples. `maxTruePeak` is the larger of that and the plain sample peak.

Every reading is `-Infinity` while there is nothing to read, never `NaN`: M for 0.4 s after a reset, S for 3 s, I until a 400 ms block passes the -70 LUFS gate, LRA until two 3 s blocks pass both gates. Digital silence leaves I where it was.

**Which buses.** `Master` is always metered, and reads the final output, after the reverb return and the limiter. In addition you choose **up to 8** other buses. Tick **Meter** on a bus in Project Settings > Audio, or write it in `project.json`:

```jsonc
"buses": [
  { "name": "Master" },
  { "name": "Music", "parent": "Master", "meter": "loudness" },
  { "name": "Voice", "parent": "Master", "meter": "loudness" }
]
```

`meter` can only be `"loudness"` and is not written when off. A ninth bus is refused with a message (the checkbox is disabled; a hand-written file drops it with a problem). `meter` on the root is dropped too: it is always metered.

## Targets

A **target** is a goal your mix is judged against, an entry of `audio.loudnessTargets` (1 to 8 entries):

| Field | Meaning | Range |
| --- | --- | --- |
| `name` | unique, up to 32 characters | |
| `integrated` | the goal, LUFS | -70 to 0 |
| `tolerance` | how far I may stray, LU (plus or minus) | 0 to 12, default 2 |
| `truePeak` | the ceiling, dBTP | -20 to 0, default -1 |

Without `loudnessTargets` the project has two: **`console`** (-24 LUFS, 2 LU, -1 dBTP) and **`mobile`** (-18 LUFS, 2 LU, -1 dBTP). They are published guidance for each kind of device, not a rule of any store; check your platform's current numbers and edit the table. The first entry is the default. Edit them in Project Settings > Audio > **Loudness targets**; the table is only written when it differs from the default.

The target in force is `Audio.loudnessTarget` (a name; the Mixer's **Target** picker sets it too). Changing it is not a reset. An unknown name warns and keeps the current one.

```ts
Audio.loudnessTarget = "mobile";
```

### Reading a verdict

Each metered bus's `loudness.target` is `null` (no targets) or a reading:

- `deviation`: `integrated` minus the goal, in LU (`-Infinity` until I has a value).
- `state`: **`waiting`** (I has no value yet), **`ok`** (within tolerance), **`high`**, **`low`**, or **`suspended`** (the check is not running, see below).
- `peakOver`: the true peak went above the ceiling.

## Using it from a script

```ts
const m = Audio.bus("Master").loudness;   // a stable object: keep it
m.reset("all");                           // "integrated", "maxPeak" or "all" (default)
// ...play a level...
console.log(m.integrated, m.shortTerm, m.lra, m.maxTruePeak);
if (m.target?.state === "high") console.warn("mix is", m.target.deviation, "LU over");
m.pause();   m.resume();                  // stop and restart measuring
```

Beyond the readings above (`momentary`, `shortTerm`, `integrated`, `lra`, `maxTruePeak`, `maxMomentary`, `elapsed` in seconds), a meter tells you how far to trust it:

- `metered`: false for a bus you did not choose, a missing bus and the Babylon fallback. All readings are `-Infinity`, and `reset`, `pause` and `resume` do nothing; none throws.
- `paused`, with `pausedBy` `"script"` or `"ladder"`; paused time is not counted in `elapsed`.
- `incomplete`: a stretch of audio was not measured (main stalled for over 3.2 s, the audio was rebuilt, or the ladder paused the meter). The block being measured never straddles the gap.
- `tainted`: a monitor control or Compare changed what the meter heard.
- `truePeakBound`: `"lowerBound"` when the core skipped the true-peak work on quiet stretches and the reading is under the target's ceiling, so the real peak can only be as high or higher. It is the right answer to "did it go over?" either way.

`incomplete` and `tainted` stay set until `reset("all")` or `reset("integrated")`.

## When the check is suspended

The target check says `suspended` (while monitor controls are on, the Mixer shows a banner saying so) while the measurement would not describe what a player hears:

- **MASTER** is not 1, or a **mute** is in force (a script, the authored bus mute or the hidden-tab mute).
- A **monitor** mute or solo from the Mixer panel is on, or **Compare** is active.

A monitor mute of a bus also **taints** that bus, its ancestors and Master; a monitor solo and Compare taint every meter. Muting from a script or the project, or a master volume other than 1, suspends the check but does not taint: the meter still measures, the verdict waits.

## In the editor

- **Mixer panel**: metered buses show M, S and I as numbers (`-inf` while empty) and a short-term bar with the target's line and tolerance band, coloured by `state`. The bar is for a bus you are judging live; the target picker, **Reset**, **Pause** (stops all meters) and the elapsed time sit above the strips.
- **Play** resets every meter when it starts (`audio.loudnessResetOnPlay`, default true; untick **Reset loudness meters on Play** to keep readings across runs). An exported game's integrated measure starts when the engine starts.
- **Audio Profiler**: the Loudness and Loudness target tracks, with a line at the target and ticks where the mix went over or under it. A reopened capture and the live meter agree because both use the same statistics. See [Loudness in the profiler](audio-profiler.md#loudness).

## Under load

When the machine is overloaded, the core's shedding ladder pauses the loudness meters of every metered bus **first**, before it gives up anything you would hear, and restores them last. **Master is never paused.** A paused meter reads `pausedBy: "ladder"` and `incomplete` once it resumes. With only Master metered the step is skipped.

## Accuracy

The readings use the standard's K-weighting and gating. Against the open `ebur128` (libebur128) crate on the same audio, M, S, I and LRA agree within about 4e-6 LU and true peak exactly; the synthesised EBU Tech 3341 and 3342 test signals pass within their tolerances. Integrated loudness and LRA are exact for the first hour of programme since the last reset; past an hour, blocks are counted in 0.1 LU steps, so I stays within about 0.1 LU and LRA becomes approximate. One caveat: at sample rates other than 48 kHz, the first K-weighting stage has a small fixed offset (under 0.03 dB at 44.1 and 96 kHz).

Numbers measure the final mix, not your content: a mix is only as comparable to a target as the device's volume is. The default targets are a start, not a verdict.

## See also

- [Audio mixer](audio-mixer.md) and [Audio profiler and capture files](audio-profiler.md)
- [Why is there no sound?](why-no-sound.md)
- [ADR 0171](../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md) and [ADR 0172](../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md)
