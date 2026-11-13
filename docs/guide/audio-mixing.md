# Live mixing and ducking (ADR 0171, amended by 0172 and 0173)

You can mix while the game plays. Press Play, open **Audio Mixer** from the editor's panels, and move a fader, mute a bus or edit a ducking rule in Project Settings > Audio: you hear it at once, with no restart. This chapter covers what applies at once, what is kept when you press Stop, how undo works, the Mixer panel, Compare, the monitor controls, the two ducking modes, and the few edits that wait for the next Play.

The buses, effects and snapshots themselves are in [Audio mixer](audio-mixer.md). Reading what the mix did afterwards is the [Audio profiler](audio-profiler.md). If a bus is silent, see [Why is there no sound?](why-no-sound.md).

## What you hear, and what is kept

An edit made while Play runs is an ordinary Project Settings edit that also reaches the running game. It is saved to `project.json`, so it is still there after Stop and in the next Play.

| You do, in Play | You hear it | After Stop |
| --- | --- | --- |
| Drag or key a fader (the bus's authored `volume`) | at once, ramped over a few milliseconds so it doesn't zip | **kept** (saved) |
| **M** on a strip, the Mute box in Project Settings (the bus's authored `mute`) | at once | **kept** |
| Edit a filter's frequency or Q, a reverb send, a snapshot, a ducking rule, an automation rule or a loudness target | at once | **kept** |
| Add a bus, add an effect at the end of a bus's list | at once | **kept** |
| Rename a bus | no change in sound | **kept** |
| Move or remove a bus, remove or reorder an effect, insert an effect before the end | after a 20 ms dip (below) | **kept** |
| Edit a compressor's numbers | blended in over about 20 ms | **kept** |
| **MM** or **S** on a strip (monitor mute, monitor solo) | at once | gone: never saved |
| Compare with Play start | the saved mix plays | gone: never saved |
| A snapshot button, a script's `Audio.snapshot(...)`, `Audio.bus(...).volume`, `fadeTo`, `mute`, `solo` | at once | gone: runtime state, as always |

The line is simple: a change to the project is kept; a change to what is happening right now is not. Edits made in Play never touch the runtime values scripts set. A script's `Audio.bus("Music").volume = 0.5` is a multiplier on the authored volume, so you can drag the authored fader while a script holds its multiplier, and neither undoes the other (see [Fades, volume and sends](audio-mixer.md#fades-volume-and-sends)). A project load (the next Play) clears every script value.

### Undo

An edit in Play is one step in the same undo history as Project Settings. A fader drag is **one** step, taken when you let go; the moving fader in between is a preview that never enters the history. A key press on a fader is one step each. Undo and redo reach the running game too: undoing a fader move brings the sound back. **Ctrl+Z** and **Ctrl+Shift+Z** work while the Mixer panel has focus, and the same steps are in Project Settings, so an undo in either place undoes it. This is the shared history of [ADR 0173](../decisions/0173-the-editor-sdk-lets-a-panel-edit-project-settings-through-the-shared-section.md).

### Structural edits dip

Moving or removing a bus, or removing, reordering or inserting an effect before the end of a bus's list, changes the audio graph. So the engine fades the affected buses out over 20 ms, makes the change, and fades them back in over 20 ms, which hides what would otherwise be a click. A sound is not stopped by this. The reverb a dipped bus feeds dips with it. Renaming a bus is not structural: its sounds, level and the handles scripts hold carry on. A script that still uses the old name keeps working, with one warning, until the next Play.

An added bus takes a free slot in the audio core. If every slot is still waiting to be recycled after a removal, the edit is queued and applies on its own a few tens of milliseconds later.

On the **Babylon fallback** there is no dip: moving, removing or adding a bus rebuilds its node graph with a short ramp and may click. There is no level ducking there either (below).

## The Mixer panel

Open **Audio Mixer** from the panels. It shows a **channel strip** for every bus, the root first, indented by depth. While the editor is not playing the strips show the saved mix and say so: levels, loudness and the monitor controls start with Play.

Each strip has:

- **Fader.** The authored volume, 0 to 2 linear, drawn on a dB scale with a mark at 0 dB (unity). Drag it (hold Shift for fine control), double-click it for unity, or use the keys below. Escape during a drag puts the old value back and saves nothing. The authored value shows under the fader, with `eff`, the **effective gain** at the speakers: every bus up the tree, snapshots, ducking, automation and scripts included.
- **M** mute: the bus's authored mute, saved with the project, one undo step. A bus muted by a script shows the button in its script state and says so in its tooltip.
- **MM** monitor mute and **S** monitor solo: see below. Both only work in Play.
- **Level meter** with a peak hold and a clip lamp. A click on the lamp or the meter clears the latch.
- **Loudness** for the buses the project meters: momentary (M), short-term (S) and, on metered buses, integrated (I) LUFS, with a bar that shows the loudness target and its tolerance band. An unmetered bus reads "Not metered".
- **Gain reduction** meter, on a bus that a level-ducking rule targets, or any bus that is ducked right now: how many dB the duck is taking off.

The fader keys (the fader is a slider: Tab to it):

| Key | Does |
| --- | --- |
| Up, Right | raise by 2 % of the travel |
| Down, Left | lower by 2 % of the travel |
| Page Up, Page Down | raise, lower by 10 % |
| Home, End | silence, top of the travel |
| Shift or Alt with a key | a finer step |
| Escape | during a drag: cancel |

The toolbar above the strips has:

- **Snapshot buttons**, one per snapshot in the project. A button fades to its snapshot, and pressing the one that is in force fades back to the plain mix. Snapshots are runtime state, so this is a way to hear a snapshot, not an edit. They work only in Play.
- **Target**: which loudness target the meters check against. **Reset** zeroes the loudness meters and the elapsed time; **Pause** and **Resume** stop and restart metering; the timer shows metered time since the last reset. With `loudnessResetOnPlay` on (the default) every Play starts at zero.
- **Compare**, below.

Banners under the toolbar say what needs your attention: a problem in the audio section (the same ones Project Settings lists under the field), an edit that waits for the next Play, monitor controls being on, and Compare being on.

Reading never writes. A script that moves a bus's volume moves its strip's meters and `eff` readout, and nothing is saved.

## Compare with Play start

When Play begins the editor keeps a copy of the project's `audio` section. **Compare** swaps that **saved** mix in for the **edited** one, so you can hear whether your changes are better, and swaps back when you press it again. It works only in Play (the button is disabled outside it), and its tooltip says when the mix is the same as at Play start.

While Compare is on:

- the faders and the **M** buttons are locked, because an edit made on top of the saved mix would be erased on the way back;
- nothing is saved and nothing enters the undo history: your edited mix is still the project's;
- every meter is marked as affected and the loudness target check is paused (the target mark reads "paused");
- each swap drops a marker on a recording, if the [profiler](audio-profiler.md) is recording.

Compare ends by itself on Stop, and when a new Play starts (that Play is built from your edited mix). Settings that only apply at the next Play (below) are not swapped.

## Monitor controls and taint

**MM** (monitor mute) and **S** (monitor solo) are for listening, like a mixing desk's PFL: they change what comes out of your speakers for as long as you hold them and are **never saved**. They are cleared when Play starts and when it stops. A monitor mute silences the bus and everything under it; a monitor mute wins over a solo on the same bus. With any solo on, a bus is heard when it is soloed, lies under a soloed bus, or is on the way to one, as with a script's `solo`. The scripted `Audio.bus(...).mute` and `.solo` are separate: a script's switch and the panel's monitor control both apply.

Because monitor controls change what the meters see, they mark meters as **tainted**:

- a monitor mute of a bus taints that bus, every bus above it and Master;
- a monitor solo taints every meter;
- Compare taints every meter it changed;
- the mark stays until you press **Reset** (or `loudness.reset("all")` or `reset("integrated")` in a script), and Play with `loudnessResetOnPlay` clears it.

A script reads it as `Audio.bus("Master").loudness.tainted`. While a monitor control or Compare is on, the loudness target check is **suspended**, not just marked, so a number measured with a bus muted is never reported as the game's loudness. A Master fader away from 1, a script's mute or an authored mute suspends the check too but does not taint the reading.

## Ducking

A **ducking rule** lowers a **target** bus while a **trigger** bus is active, then lets it return. The classic use is music under dialogue. Rules are in Project Settings > Audio > **Ducking**; **+ Ducking rule** adds one. There are at most 32 rules, at most 8 of them level rules. A ducking edit applies at once, in Play too.

Every rule has:

- `target`, `trigger`: two buses. The trigger can't be the target or above it in the tree (its level couldn't be measured before the target is mixed).
- `amount` (0 to 1): the multiplier the target heads for while ducked. 0.4 is about 8 dB down; 0 is silence. Default 0.4.
- `attack`, `release` (seconds, 0 to 10): how long the duck takes to arrive and to let go. Defaults 0.1 and 0.5.
- `mode`: `"presence"` or `"level"`.

### Presence mode

The target ducks **while the trigger has sounds playing**, however quiet they are. A sound counts from its own first frame, and virtual voices count. It is the cheap mode and works on every backend.

Use it when a bus is either busy or not: a Voice bus that only plays lines, a stinger bus.

### Level mode

The target ducks while the trigger's **measured level is over a threshold**, so a trigger bus that plays quiet sounds, or sounds with silence in them, doesn't duck the target. A level rule adds:

- `detector`: `"rms"` (the default; a smooth 10 ms average, which follows how loud something sounds) or `"peak"` (reacts at once, releases over 10 ms; catches short hits).
- `threshold` (-80 to 0 dBFS, default -30): the level where ducking starts. The duck deepens over the next 6 dB and reaches the full `amount` at threshold + 6 dB. A trigger just over the threshold ducks the target a little, a loud one fully.

A new rule starts as a level rule with an RMS detector at -30 dBFS. The trigger is measured **before** its own fader and mute, after its effects and snapshot filter, so turning the trigger bus down or using a monitor mute on it does not change the duck. A target's gain-reduction meter in the Mixer shows what the duck is doing.

Level mode needs the audio core. On the Babylon fallback a level rule is kept in the project but never ducks, and the rule says "Needs the audio core". The same goes for a project on `audio.backend: "babylon"` (see [Choosing the backend](audio-mixer.md#choosing-the-backend)).

Rules can't form a loop: A ducking B and B ducking A is refused, and so is any longer chain that comes back round, with a message naming the rules. Presence rules are exempt.

### Examples

```jsonc
"ducking": [
  // Dialogue: music drops whenever a line is playing. Presence is enough, and the rule is cheap.
  { "target": "Music", "trigger": "Voice", "mode": "presence", "amount": 0.4, "attack": 0.1, "release": 0.6 },

  // Sidechain: SFX ducks 6 dB under the Voice bus only while it is actually loud,
  // so breaths and room tone between words don't pump the SFX.
  { "target": "SFX", "trigger": "Voice", "mode": "level", "detector": "rms",
    "threshold": -30, "amount": 0.5, "attack": 0.05, "release": 0.4 },

  // Hits: a quick peak detector ducks ambience under heavy impacts for a moment.
  { "target": "Ambience", "trigger": "Impacts", "mode": "level", "detector": "peak",
    "threshold": -18, "amount": 0.3, "attack": 0.02, "release": 0.8 }
]
```

Rules on one target combine by taking the lowest, in both modes: two rules on Music, one presence and one level, give whichever is ducking harder at that moment. Ducking is its own gain. A fade, a snapshot and a duck on the same bus don't undo each other.

Adjust a level rule while the dialogue plays: the threshold, amount, attack and release take effect as you commit each number.

## Applies at the next Play

Live editing covers six keys of the `audio` section: `buses`, `snapshots`, `ducking`, `automation`, `loudnessTargets` and `loudnessResetOnPlay`. Every other key (the backend, voice limits and presets, clip memory and format, codecs, limiter look-ahead, the music rings and rhythm mode, the spatial settings such as occlusion and reverb zones) is saved and applies at the next Play. The panel says "Applies at the next Play: ..." in a banner. So do these cases:

- a **fifth effect** on a bus while playing (a bus runs its first four while playing; see [Limits](audio-mixer.md#limits));
- a structural edit the engine can't do live (for example with no audio backend running);
- a level-ducking rule on the Babylon fallback (the answer is "Needs the audio core").

A bus's spatial `bed` and `bedPriority` are live: the beds are planned again as you change them ([Spatial audio](spatial-audio.md#beds)).

The edit is never lost: it is already in `project.json`. If the banner is more than you want to see, press Stop and Play.

## See also

- [Audio mixer](audio-mixer.md): buses, effects, snapshots, scripting.
- [Audio profiler](audio-profiler.md): record a session, the Bus gain track, loudness.
- [Playing sound](playing-sound.md)
- [ADR 0171](../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md), [0172](../decisions/0172-audio-mix-design-corrections-and-owner-decisions.md), [0173](../decisions/0173-the-editor-sdk-lets-a-panel-edit-project-settings-through-the-shared-section.md), and [0147](../decisions/0147-the-editor-sdk-gives-plugins-the-project-status-and-scene-through-one-editor-object.md) for the `editor.project.onSectionChanged` hook the audio plugin uses.
