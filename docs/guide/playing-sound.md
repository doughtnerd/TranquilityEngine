# Playing sound

Two ways to make sound: an `AudioSource` component on a node, and `Audio.playOneShot` for fire-and-forget sounds. Both play through the project's [mixer buses](audio-mixer.md). For variations, layers, parameters and sustained sounds authored as data, see [Sound events](sound-events.md): `Audio.play` plays an event, and `AudioSource.clip` can name one. Nothing plays until the player has clicked or pressed a key once; see [Why is there no sound?](why-no-sound.md) if something is silent.

```ts
import { Audio, AudioSource } from "myco";
```

## One-shots

```ts
Audio.playOneShot("sfx/jump.wav");                       // a bare number is the volume: playOneShot("sfx/jump.wav", 0.5)
Audio.playOneShot("sfx/cannon.wav", {
  bus: "SFX",                                            // default Master
  volume: 0.8,                                           // linear, default 1
  pitch: 0.9,                                            // playback rate, 2 is an octave up (0.0625 to 16)
  position: ship.worldPosition,                          // set: 3D sound; left out: flat
  minDistance: 5, maxDistance: 150,                      // metres, with position
  priority: 200,                                         // 0 to 255, default 128
  dopplerLevel: 1,                                       // with position: opt in to the pitch shift of a moving sound (default 0)
  occlusion: true, reverbSend: 1,                        // with position: walls and reverb zones (the defaults)
  lowpass: 4000, highpass: 80,                           // Hz, any sound; the lowest low-pass wins
  yaw: 90,                                               // ambisonic clips: degrees
});
```

`playOneShot` never throws and always returns a handle. Keep it to stop or fade the sound:

```ts
const engine = Audio.playOneShot("sfx/engine.wav", { bus: "SFX" });
engine.fade(0.3, 1);       // ease this sound's own volume to 0.3 over 1 s
engine.stop(0.5);          // fade out over 0.5 s, then stop
engine.playing;            // false once it ended or was stopped
engine.reason;             // why it isn't audible (or why it ended early), else null
engine.panner;             // "flat", "equalPower", "hrtf", "bed" or "ambisonic" (null before it plays)
engine.occlusion;          // how much of the dry sound a wall lets through: 1 is clear
```

`at` starts a sound at an exact time on the audio clock, for music that has to line up: `Audio.playOneShot("music/hat.wav", { at: Audio.time + 0.5 })`. `Audio.time` is the clock the player hears, in seconds, and doesn't stop when the game pauses.

When a limit is hit (`maxVoices` on a bus, or the voice counts in Project Settings > Audio), `priority` decides which sound gives way; a higher value is kept longer. The default suits most games.

## AudioSource

Add an `AudioSource` component to a node and pick its `clip`, or drag an audio file from the Assets panel into the scene, which makes a node with one.

| Field | Meaning |
| --- | --- |
| `clip` | The audio asset |
| `volume`, `pitch` | Gain (linear) and playback rate |
| `loop` | Start over at the end |
| `playOnAwake` | Start when the node becomes active (default on) |
| `output` | The bus it plays on; empty is Master |
| `priority` | 0 to 255, as above |
| `spatial`, `minDistance`, `maxDistance`, `rolloff` | 3D sound, below |
| `occlusion` | On (default): walls between the sound and the listener muffle it ([Spatial audio](spatial-audio.md#occlusion-and-materials)) |
| `dopplerLevel` | 0 to 5, default 1: how much a moving source or listener shifts the pitch; 0 is off |
| `reverbSend`, `reverbSendCurve` | How much goes to the reverb zones that hold the source (0 to 2, default 1), and how that changes with distance |
| `ambisonicYaw` | Ambisonic clips: turns the recording about the vertical axis, degrees |

```ts
const source = this.node.getBehavior(AudioSource)!;
source.clip = "music/town.mp3";
source.loop = true;
source.play();      // also pause(), resume(), stop()
source.isPlaying;
```

Read-only: `velocity` (world units per second, from the node's motion), `panner` and `occlusionGain` (1 is clear). Changing `volume`, `pitch` or the 3D fields while it plays takes effect on the next frame. A deactivated node pauses its sound; destroying the node stops it.

## Buses and master volume

Every sound plays on a bus (`Master` unless you say otherwise). Buses, effects, snapshots and ducking are in [the mixer guide](audio-mixer.md). The master controls are on `Audio`:

```ts
Audio.volume = 0.7;       // 0 to 1; Audio.masterVolume is the same property
Audio.muted = true;       // reads back too
Audio.bus("Music").volume = 0.5;
```

## Sound files

WAV, FLAC, MP3 and Ogg Vorbis play everywhere; AAC (`.m4a`, `.mp4`, `.aac`) plays once you turn on **AAC** in Project Settings > Audio (it adds a larger decoder, about 1 MB). Opus and AIFF are not supported. Each clip plays at the sample rate of its file. Details and limits are in [Sound files and decoding](atmosphere-and-sound.md#sound-files-and-decoding).

Per-clip settings are in the asset's import settings (the `<asset>.meta.json` beside it, for example `music/town.mp3.meta.json`: `{ "format": "myco.import@1", "stream": true }`): `volume` scales every playback of the clip, and `stream` is for long files.

### Streaming

Turn on **stream** for music and other long files. The clip is then decoded in small pieces while it plays, so it starts at once and takes little memory. A streamed clip is a normal sound otherwise: it can be spatial, pitched, looped and routed to a bus with effects. If the file can't be read fast enough, the sound fades out until data arrives (its `reason` reads `"waitingForData"`). Short effects should not stream: a clip that isn't streamed is decoded once and kept, which is cheaper for sounds that play often.

### Loops

`loop` on an `AudioSource` (or a looping clip) wraps from the last sample to the first with no gap when the file says how much silence its encoder added: WAV and FLAC always, Ogg Vorbis, MP3 files with a LAME/Info tag, and M4A. An MP3 without that tag and a raw `.aac` file keep a short gap; re-encode them. See [Gapless loops](atmosphere-and-sound.md#sound-files-and-decoding).

## 3D sound and HRTF

Turn on `spatial` on an `AudioSource`, or pass `position` to `playOneShot`. Sound then pans and fades with the distance and direction from the World's `AudioListener` (put one on the camera or the player; without one the main camera listens). Volume is full inside `minDistance` and falls to `maxDistance` by the `rolloff` curve (`linear`, `inverse` or `exponential`). Spatial sources follow their node.

On the audio core, the nearest spatial sounds are rendered with **HRTF**: over headphones they seem to come from outside the head, in front or behind, above or below. The rest are panned left to right only (equal power). In Project Settings > Audio > Playback:

- **Spatial** is `hrtf` (default) or `equal power` (no HRTF at all, cheapest).
- **Voices > HRTF** is how many spatial sounds get HRTF at once (0 to 32, default 16). 0 means equal power for all.

Sounds beyond the HRTF count are mixed into a shared **bed** instead of being panned flat, where the bus has one (see [spatial audio](spatial-audio.md#beds)). If the HRTF data can't load, spatial sounds stay equal-power and the Audio Debug panel says so. The Babylon fallback uses the browser's own panner, so 3D sound there differs between browsers. More in [spatial audio](atmosphere-and-sound.md#spatial-audio-0074).

**Walls, rooms and moving sources.** Spatial sounds are also muffled by walls (`AudioOccluder`), can take the echo of a room (`AudioReverbZone`) and shift in pitch as they pass (`dopplerLevel`), and recorded surroundings can be played as ambisonic clips. All of it is in [Spatial audio](spatial-audio.md), with a recipe for doors. A listener that moves quickly (a vehicle) can say so with `AudioListener.setVelocity(v)`; otherwise its speed is read from the node's motion.

## Which backend plays

The audio core is the default. The Babylon fallback plays instead when you set `audio.backend` to `"babylon"`, on macOS desktop builds (until macOS passes its check), and on engines too old to run the core (one warning in the console). It plays the same API with no effects, priorities, HRTF, reverb zones or beds, and walls only lower the volume (see [Spatial audio](spatial-audio.md#the-babylon-fallback)); the full list is in [the mixer guide](audio-mixer.md#limits) and the browser versions are in [audio-minimum-versions.md](audio-minimum-versions.md).

## Testing and tuning

`Audio.debug()` returns a copy of the audio state: status, buses with their peaks, and every playing sound. In the editor, the **Audio Debug** panel (Window menu) shows the same while the game plays. See [Why is there no sound?](why-no-sound.md).
