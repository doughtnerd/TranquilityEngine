# Fog, camera rays and spatial audio

Three small features from ADRs 0071, 0073 and 0074.

## Fog (0071)

Add a `Fog` component to any node (Create > Fog). The first enabled one in a World applies to every material that takes fog: lit, unlit and physical materials, shader graphs, sprites and particles. Editor gizmos and screen-space UI never do.

| Field | Meaning |
| --- | --- |
| `mode` | `linear` or `exponential` |
| `color` | Fog colour |
| `near`, `far` | Linear: where fog starts and where it is total (metres) |
| `density` | Exponential: thickness |
| `affectsSkybox`, `skyboxFog` | Also fade the sky towards the fog colour, by `skyboxFog` (0 to 1). A flat background lerps; a skybox texture dims by that fraction and becomes the fog colour at 1. |

Every field can change each frame (`fog.far = lerp(...)` fades a storm in) without recompiling materials. Turning fog on or off, or switching `mode`, recompiles once.

A material opts out with `"fog": false` in its `.material.json` (glows, sun discs).

## Camera rays and screen points (0073)

```ts
const cam = Camera.main!;
const ray = cam.screenPointToRay(Input.mousePosition);   // canvas pixels, origin top-left
const ground = Plane.fromNormalAndPoint(Vector3.up, Vector3.zero);
const t = ground.raycast(ray);                            // distance along the ray, or null
if (t !== null) target = ray.at(t);

const hit = Physics.raycast(ray, 200);                    // a Ray works with Physics.raycast

const label = cam.worldToScreenPoint(ship.worldPosition); // x, y in pixels; z = distance in front (negative: behind)
```

`viewportPointToRay` takes 0 to 1 coordinates with the origin bottom-left. `aspect` is the camera's viewport width over height. Orthographic cameras give parallel rays starting on the camera's plane. Without a render backend (tests), the project's reference resolution is the canvas size.

## Spatial audio (0074)

Add an `AudioListener` to the node that hears (usually the camera or the player). Without one, the main camera is the listener. On an `AudioSource`, turn on `spatial` and set `minDistance` (full volume inside), `maxDistance` and `rolloff` (`linear`, `inverse`, `exponential`). `pitch` is the playback rate for every source. Spatial sources follow their node while playing.

```ts
Audio.playOneShot("sfx/cannon.wav", { position: ship.worldPosition, volume: 0.8, pitch: 0.9, maxDistance: 150 });
```

Only the World that has the view plays sound. On the audio core a clip imported with `stream` is spatial like any other; on the Babylon fallback it can't be, so it plays flat with a warning. On the Babylon fallback the browser's own panner places the sound, so 3D audio differs between browsers; see [the mixer guide](audio-mixer.md#limits).

### Sound files and decoding

Import WAV, FLAC, MP3 or Ogg Vorbis files (AAC is not decoded by the audio core yet; it becomes an opt-in later). On the audio core a worker thread decodes them with the engine's own decoder, so loading a long clip never stalls a frame, and every clip plays at the sample rate of its file whatever the device runs at. An MP3 without a length header (some variable-bitrate files) loads like any other. A file that can't be read fails to load with one warning naming it; the rest of the project keeps playing.

The **stream** import setting is for long files such as music. On the audio core a clip with `stream` on isn't decoded up front: the worker decodes it in small pieces while it plays, so it starts quickly and takes little memory. Otherwise a streamed clip is a sound like any other there: spatial (HRTF included), pitched, looping, on its bus with the bus's effects. If the file can't keep up, the sound fades out until data arrives and fades back in; if it fails it stops with one warning naming the file. On the Babylon fallback streamed clips play as the browser's own HTML5 audio, flat and unpitched (see [the mixer guide](audio-mixer.md#limits)).

On the Babylon fallback the browser decodes: its own `decodeAudioData` handles whatever formats that browser supports, so a format the core can't read may still play there.

3D sound over headphones uses the IRCAM Listen HRTF database (IRC_Composite_C, Copyright 2002 IRCAM). We thank IRCAM for making it available.
