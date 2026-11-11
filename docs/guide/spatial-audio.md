# Spatial audio (ADR 0162)

How sound behaves in a place: far-away sounds that cost almost nothing, rooms that echo, walls and doors that muffle, moving things that change pitch as they pass, and recorded surroundings that turn with the listener. It builds on [3D sound](playing-sound.md#3d-sound-and-hrtf) (a sound with `spatial` on, heard from the `AudioListener`), which you should know first. The audio core does all of it; the [Babylon fallback](#the-babylon-fallback) does a little of it. The **Sound Lab** sample has a page that uses every feature here: open it with `npm run dev`, go to `/editor.html?sample=sound-lab`, press Play, click the game view and press **S** (its files are in `samples/sound-lab/`, the scene is `scenes/spatial.scene.json`).

Plain words for terms used below:

- **Listener**: the `AudioListener` (on your camera or player) that hears everything.
- **Bus**: a channel of the mixer that sounds play on ([the mixer](audio-mixer.md)).
- **World unit**: one unit of position. The guide says metres, because the defaults assume 1 unit is 1 metre; if your game uses another scale, scale the distances to match.
- **Ray**: a straight line the engine tests against colliders, to ask "is something between these two points?".

## Beds

Every spatial sound that gets **HRTF** (the filtering that makes headphones place a sound outside your head) costs the same each, so a crowd of 200 of them would be too much. A **bed** is the cheap way for the rest. Think of it as one shared sound field around the listener: the engine places each distant sound into that field by its direction, then converts the whole field to your headphones once. The cost of the conversion is the same whether the field holds 5 sounds or 500.

The nearest sounds keep their own HRTF, because they are the ones you can pick out; the distant ones go to the bed, and a sound moves between the two as it comes closer or goes away (with a short crossfade and a half-second pause, so a sound hovering at the boundary doesn't flip back and forth). Which sounds get HRTF is the **Voices > HRTF** count in Project Settings > Audio: 8 by default (4 on the low preset), with **Max beds** 2 (4 on high, 0 on low, which turns beds off).

A bed belongs to a bus. In Project Settings > Audio, each bus has two settings (in `project.json`, `buses[].bed` and `buses[].bedPriority`):

| Setting | Meaning |
| --- | --- |
| `bed` | `own`: this bus has its own bed. `parent`: its sounds go into its parent's bed (the default for every bus but Master). `none`: no bed, so its distant sounds are panned left and right only |
| `bedPriority` | 0 to 255 (default 128; Master 255). When more buses ask for `own` than the project allows, the higher number gets one; the others share the bed above them |

`audio.bed.maxBeds` (0 to 4, default 2) is how many beds the project can afford; 0 turns beds off. Give a bed to a bus whose sounds you want to keep apart from the rest: the Sound Lab's Ambience bus asks for its own, so ambience can be heard the same way whatever else is loud. A bus that **shares** another's bed gives up two things for its distant sounds: its own effects and its own meter (the host's apply). The Project Settings > Audio panel shows which bus hosts each bus's bed and warns when a bus asked for one and lost. The Audio Debug panel's **Beds** section lists each bed, who shares it and its cost.

Beds hold **spatial** sounds. They also work when Project Settings > Audio > Playback > **Spatial** is `equal power`: the field is then converted to left and right with a simpler, cheaper mix and no HRTF.

## Reverb zones

A **reverb** is the sound of a space: the echoes that keep going after a sound stops (its **tail**). An `AudioReverbZone` is a box or sphere in the world with its own reverb. Put one on a node, give it a size, and any spatial source inside it (or close enough to be fading in) sends some of its sound to that reverb.

| Field | Meaning |
| --- | --- |
| `shape`, `center`, `size`, `radius` | The volume. A box is `size` along each axis, a sphere `radius`, both scaled by the node |
| `preset` | `room`, `corridor`, `hall`, `cave` or `open` (below) |
| `ir` | An **impulse response**: a recording of a real space reacting to a click, as a WAV or FLAC file (mono or stereo). When set it replaces the preset |
| `wet` | How loud the reverb is, 0 to 2. 1 is the level an impulse response is calibrated to |
| `blendDistance` | The reverb fades in over this many units outside the volume. 0 is a hard edge |
| `priority` | Which zone wins when more are needed than can play at once |
| `output` | The bus the reverb returns to. Empty is Master |

The presets are made by the engine, and differ in how long the tail lasts and how dull it gets: `room` about 0.45 s, `corridor` 1.1 s, `hall` 2.2 s, `cave` 3.6 s (the longest and darkest) and `open` 0.9 s (starts late and has a soft top end, like open ground with distant walls). Pick the one nearest and set `wet`; use an impulse response when you have the real space.

Each **source** decides how much of itself goes to the zones that hold it, with `reverbSend` on the `AudioSource` (0 to 2, default 1) and `reverbSendCurve`, which sets the send against distance. The default curve fades the send from full to half between `minDistance` and `maxDistance`; a distant source can keep a lot of reverb while its direct sound falls away, which is how a far-off shout sounds in a big space. The send is taken before the distance fade for that reason. A sound **event** has the same two as `sends.reverb` and `spatial.reverbSendCurve` ([Sound events](sound-events.md#sends-and-filters)). The `reverb` effect of a bus ([the mixer](audio-mixer.md)) still exists beside the zones: it is the one shared reverb that sounds outside every zone use.

Limits: at most **2 zones are active** at once (each is a convolver, and a long tail takes memory), and one more slot (**standby**) lets the tail of a zone you just left ring out instead of being cut. The loudest zones win; `priority` breaks ties. If a zone can't play, the engine warns once, naming it, and the Audio Debug panel's **Zones** section gives the reason (`faded: preset has 2 reverbs`, `IR failed: ...`, `wet 0`, `no sources inside`). Settings, in `audio.zones`: `maxActive` (0 to 2, 0 makes zones do nothing), `standby` (0 or 1) and `maxIrSeconds` (longer impulse responses are cut with a short fade). The Voices preset sets them (low: 1 zone, no standby, 1 s; default and high: 2 zones, standby, 2 s and 4 s).

Zones need no physics. In the editor, a zone draws its volume and its fade shell; turn on **Edit Zone** in its Inspector header to drag the faces, and use the Inspector's audition button to hear it from the editor camera.

## Occlusion and materials

A sound behind a wall is quieter and duller: the wall absorbs some of it and mostly lets the low tones through. **Occlusion** does that. Every few frames the engine draws a ray from the listener to each spatial source, and every `AudioOccluder` collider the ray crosses takes some of the sound away. (Unity, Wwise and FMOD all leave the rays to the game; here the engine casts them for you, and you only say what is a wall.)

What you need:

1. A **3D physics** world (the scene's `settings.physics` is `"3d"`). In a 2D world, occlusion does nothing, and the panel says "2D world".
2. A **collider** on the wall (a `BoxCollider`, say). It can be invisible and need not be solid.
3. The collider on a **physics layer that occludes**. `audio.occlusion.layers` lists them (`null`, the default, means every layer except sensors; an empty list turns occlusion off). The Sound Lab adds a `Walls` layer to its physics layers and lists only it, so the floor and the props never muffle anything.
4. An **`AudioOccluder`** on the wall's node (or on a parent: it covers the colliders of its node and its children, nearest one wins, like a `RigidBody`). Without one, a collider uses the project's default material.

The occluder chooses the **material**, from Project Settings > Audio > Occlusion:

| Material | Loss when a ray crosses it | Low-pass cutoff |
| --- | --- | --- |
| `none` | 0 dB (see-through) | 22,000 Hz |
| `cloth` | -4 dB | 8,000 Hz |
| `glass` | -8 dB | 5,000 Hz |
| `wood` | -12 dB | 2,500 Hz |
| `metal` | -25 dB | 1,200 Hz |
| `concrete` | -30 dB | 800 Hz |

These are starting points; they are edited in the project's table, and you can add your own (name, loss in dB, cutoff, how much of a source's reverb the wall takes, and optional attack and release times). The **low-pass** is a filter that removes the high tones above the cutoff. A wall's loss is **per crossing, not per metre**: a thin wall and a thick one of the same material are the same. Crossing several walls adds their losses (never below -60 dB) and uses the lowest cutoff. Reverb is dimmed too: a source behind a wall sends less to the zone it is in.

Setting the material to `none` makes the colliders see-through to sound. Each occluder also has three numbers for the one wall: `transmissionTrimDb` (more loss, negative numbers muffle more), `cutoffScale` (below 1 duller) and `openness` (0 closed, 1 open: how much of the wall's effect is gone). Occlusion changes take a moment (100 ms by default, `audio.occlusion.smoothingMs`) so a source stepping behind a pillar doesn't click.

On a source, `occlusion` (default on) turns it off for that one sound, and `occlusionGain` reads how much of the dry sound is getting through (1 is clear). A one-shot has `occlusion` in its options; its handle has `occlusion`. When a wall brings a sound below audibility, its `reason` is `"occluded"` ([Why is there no sound?](why-no-sound.md#4-a-sounds-reason)).

The engine has a ray budget (`audio.occlusion.budgetMs`, 0.06 ms on low, 0.25 default, 0.5 high), spent on the loudest sources first, so a scene with a thousand sources sees the most audible ones updated within a few frames and the rest within about a third of a second. The **Occlusion** section of the Audio Debug panel shows the rays and their age, and the viewport can draw them (the occlusion overlay).

### The door recipe

A door is a wall that can be open. It is a collider with an `AudioOccluder` whose `openness` a script moves.

1. Make a node `Door` with a `BoxCollider` the size of the doorway, on the occluding layer.
2. Add an `AudioOccluder` to it. Pick the material (`wood`).
3. Add a script that moves `openness` between 0 and 1.

```ts
import { AudioOccluder, GameBehavior, Input, Time, behavior, field } from "myco";

@behavior("game.Door")
export class Door extends GameBehavior {
  @field(Number) seconds = 0.8;   // how long the door takes to open
  private target = 0;

  update(): void {
    const wall = this.node.getComponent(AudioOccluder);
    if (!wall) return;
    if (Input.getKeyDown("f")) this.target = 1 - this.target;
    const step = Time.deltaTime / this.seconds;
    wall.openness = this.target > wall.openness
      ? Math.min(this.target, wall.openness + step)
      : Math.max(this.target, wall.openness - step);
  }
}
```

That is the whole recipe. Three things to know:

- **Move it a little each frame.** Setting `openness` from 0 straight to 1 also works (the engine smooths the change), but a door that swings over 0.8 s sounds like a door that swings. `openness` blends the door's loss toward nothing, so a half-open door muffles about half as much (in dB) and is about half as dull.
- **Show it.** `openness` moves nothing on screen. The Sound Lab's `Door` script (`samples/sound-lab/scripts/behaviors/Door.ts`) also slides a child node (the panel) up out of the doorway. The collider stays where it is: the audio only looks at `openness`.
- **A door that's simply gone.** Disabling the collider also works, because a disabled collider is not hit. Use `openness` for a door that takes time to move, and disabling for one that jumps.

Colliders that move (a sliding door, a lift) use the same rays, so a moving collider needs nothing special. To try it, press **F** in the Sound Lab's spatial page: stand in the corridor and the radio in the room behind the door is muffled, then clear.

## Doppler

The **Doppler effect** is the pitch change of a sound that moves towards you (higher) or away (lower), like a passing siren. The engine computes it from how fast the source and the listener move along the line between them. The formula is the one OpenAL, Unity and FMOD use, with the speed of sound as `speedOfSound` (343 world units per second by default, `audio.speedOfSound`).

- `dopplerLevel` on an `AudioSource` (0 to 5, default 1) scales it; 0 is off, 2 doubles the shift. A one-shot has the option too, but its **default is 0** (opt in). A sound **event** sets it in its `spatial` block and keeps that value (a source playing an event does not override it; Doppler is authored on the event, as in Wwise and FMOD).
- The speed comes from how the node moved since the last frame. `AudioSource.velocity` and `AudioListener.velocity` read it. If a physics body drives a node, `AudioListener.setVelocity` can pass its velocity in, and `setVelocity(null)` goes back to estimating.
- **Guards.** A jump bigger than `audio.doppler.maxSpeed` (150 units per second by default) in one frame is a **teleport**, not a very fast mover: the shift is held at zero for a moment, so a respawn or a camera cut doesn't whoop. After a long frame (a hidden tab, a debugger), speeds reset. The shift is limited to half to double the pitch and smoothed over about 60 ms.
- The result multiplies the sound's `pitch`, so it adds no extra cost.

The Sound Lab's flyover (key **V**) is a `hum-loop.wav` source with `dopplerLevel` 1 that a `PassBy` script moves up and down the corridor at 30 units per second: about a 9% shift each way. Walk with W and the listener's own speed shifts it too. The Sound Lab's other moving sources have `dopplerLevel` 0, so the older sounds on its tour page stay in tune.

## Ambisonic clips

An **ambisonic** recording captures a whole sound field around one point (a forest, a street, a room), not one direction. It is stored as extra channels, and the engine can turn the field to follow the listener's head, so the forest stays where it is when the camera turns. Use it for ambience and for sound that comes from everywhere. It is not for sounds that have a place of their own (use a spatial source there).

A clip is ambisonic only because of its import settings, the `<clip>.meta.json` next to it:

```json
{ "format": "myco.import@1", "ambisonic": { "order": 1, "convention": "ambix" } }
```

- **order** is how detailed the field is: 1 (4 channels), 2 (9) or 3 (16). Higher order places sounds more sharply and costs more space. It can be left out (the channel count says it); a number that disagrees with the channel count fails the load. Orders 2 and 3 must be WAV (FLAC stops at 8 channels).
- **convention** says how the channels are arranged. **AmbiX** (the default) is the one most tools write now: channels in ACN order and SN3D scale, the one YouTube and most current plug-ins use. **FuMa** is the older layout (Furse-Malham: a different channel order and scale, used by early tools and some libraries); set `"convention": "fuma"` for those and the engine converts it. If a sound is in the wrong place or one side swaps, the convention is the usual suspect.
- A file with 4, 9 or 16 channels **needs** the `ambisonic` block: without it the load is refused (a multichannel surround mix isn't supported). On a mono or stereo clip the block is ignored with a note. The Asset Inspector has the same settings as a checkbox, an order and a convention.
- `stream` works; when `ambisonic` is set and `stream` isn't, clips longer than 5 seconds stream.

Play it like any clip, from an `AudioSource` or `Audio.playOneShot("ambience.wav", { bus: "Ambience", yaw: 90 })`. It ignores `spatial`, the distances and `dopplerLevel`, and `occlusion` (it is the world around you, so it is neither close nor far; one warning per source tells you). `ambisonicYaw` (-180 to 180 degrees, positive turns it to the left seen from above) rotates the recording to taste. `reverbSend` still works, taking the clip's overall level to the zones that hold the **listener**. `audio.ambisonic.maxClips` (0 to 4; 1 on low and default, 2 high) caps how many play at once; the lowest priority loses.

An ambisonic clip plays into the bed of its bus when the bus has one, and through a private decoder of its own when it doesn't (`maxClips` limits those). The Sound Lab's ambience (`audio/ambience-o1.wav`, 4 channels, 44.1 kHz, 2.5 seconds, 882 KB, looped) is first order; `samples/sound-lab/tools/makeAmbience.mjs` makes it, and `makeAmbisonic.mjs` in the same folder makes test tones at any direction in 1st to 3rd order (and FuMa twins) if you want to check your own setup: tone at 90 degrees should be heard on your left.

## The Babylon fallback

The [Babylon fallback](playing-sound.md#which-backend-plays) plays sound where the audio core can't run, and by default on macOS desktop builds. It does what it can with the browser's own audio, so spatial audio there is reduced:

| Feature | On the fallback |
| --- | --- |
| Beds, `bed` and `bedPriority`, HRTF vs equal power | None. The browser's panner places every sound; the settings still load |
| Occlusion | **Volume only**: a wall lowers the sound by its loss, but there is no low-pass. One warning |
| Doppler | Works, by changing the playback rate, **only on clips that are decoded** (not on a clip with `stream` on, which plays flat) |
| Reverb zones | **Do nothing**, with one warning. There is no way to add a reverb to the browser's audio from the engine |
| Event `filter`, `lowpass` and `highpass` options, aux sends | Skipped, one warning per asset |
| Ambisonic clips | Only the omnidirectional channel plays, as ordinary mono, with one warning and no turning. A clip over about 21 seconds at 3rd order (83 seconds at 1st) is refused: the browser would need more than 64 MB to decode it. Streaming is ignored for these |
| Listener velocity | Feeds Doppler |

So a macOS desktop player hears walls that only turn the volume down and no reverb zones. The Audio Debug panel and the Event editor's audition say which backend is playing. To check, play your game on both (set `audio.backend` to `"babylon"` in `project.json`).

## How this compares with other engines

Where Myco follows the tools you may know, and where it differs, in plain words.

| Area | Same as | Different |
| --- | --- | --- |
| Beds | Wwise's per-bus ambisonic setup, where a child bus mixes into its parent | A bus that shares a bed loses its own effects and meter for distant sounds; `maxBeds` limits the cost. The binaural conversion is MagLS, the method used by the IEM and SAF toolkits |
| Occlusion | Wwise and FMOD: an occlusion amount lowers volume, low-passes and thins the reverb | The engine casts the rays for you, with a frame budget spent on the most audible sources first (Unreal ticks each source on its own timer); a wall's loss is one figure, not per frequency band as in Steam Audio |
| Reverb zones | Wwise rooms: membership is per **source**, with a send level that follows distance, tails that finish ringing, and a return bus you choose | Unity's reverb zones and FMOD's reverb are about the **listener's** position instead. Myco has no **portals** (openings that carry sound between rooms), so sound doesn't bend round a door; occlusion through a door's `openness` is what stands in. At most 2 zones play at once |
| Doppler | The OpenAL, Unity and FMOD formula, and Unity's `dopplerLevel` | A teleport guard and a reset after a long frame are added |
| Event effects | FMOD's event effects | Per voice, because voices are positioned one by one |
| Voice filters | Wwise's voice filters (they affect the dry sound and the reverb) | The lowest cutoff wins instead of the filters stacking |
| Sends | A send after the bus's fader, as Unity's mixer does | A zone's send also takes the sound's bus gain; Wwise's doesn't |
| Reverb return | Wwise returns a room's reverb to an aux bus | Zone reverb goes into a bus you pick, before that bus's effects |

If you move from Unity: `AudioReverbZone` is similar but this one is per source and has presets plus impulse responses; `reverbSend` is Unity's `reverbZoneMix` (a wider range, 0 to 2); and `dopplerLevel` is the same. From Wwise: an `AudioOccluder` is an acoustic texture on a wall, a zone is a room without portals, and `openness` is the door's portal opening in miniature.

## Tuning and testing

- The **Audio Debug** panel (Window menu) while you play: counters, **Beds**, **Zones** and **Occlusion** sections, and per-sound columns for the panner (`flat`, `equalPower`, `hrtf`, `bed` or `ambisonic`), occlusion gain and cutoff, which stage set the low-pass, and the sends. `Audio.debug()` has the same data for scripts and bug reports.
- Zone fields, occluder fields, materials and `AudioSource` fields apply while you play: change `wet`, `blendDistance` or a material's cutoff in the Inspector and hear it.
- Costs: beds and zones take fixed memory when the project starts (roughly 10 MB on the default Voices preset, 3 MB on low, 21 MB on high), whether you use them or not; set `maxBeds` or `zones.maxActive` to 0 to give it back. If a scene is too heavy for the audio thread, the engine drops the extras of the least audible sounds first (`m3Shed` in the counters counts it).
- Not hearing something? [Why is there no sound?](why-no-sound.md) has a section on occluded and spatial sounds.
