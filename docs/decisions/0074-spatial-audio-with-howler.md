# 0074. Spatial audio through Howler's spatial API, with an AudioListener component

- **Status:** Accepted, extended by 0097; amended by 0157 (playback moves from Howler to the engine audio core; fields and behaviour kept)
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0006 (amends: spatial audio through Howler, not three.js `PositionalAudio`), 0010

## Context

0006 planned Howler for playback and three.js `PositionalAudio` for 3D sound, sharing an `AudioContext`. Only non-spatial `AudioSource` and `Audio.playOneShot` exist (implementation status, 0006 row). Ship games need cannon fire, impacts and thunder that pan and fade with distance.

Howler 2.2 (already a dependency) has a spatial API: `howl.pos/orientation/pannerAttr` per sound and `Howler.pos/orientation` for the listener, over Web Audio `PannerNode`s. Using it keeps one audio library and one `AudioContext`. three's `PositionalAudio` would need a second graph and a `THREE.AudioListener` tied to the render backend, which servers and tests don't have.

## Decision

- **`AudioListener` component.** The first enabled one in the World that has the view (0034) sets Howler's listener position and orientation each frame from its node: forward is the node's -Z, up is +Y. Without one, the main camera is the listener.
- **`AudioSource` fields:**
  - `spatial: boolean` (default false).
  - `minDistance` (default 1): full volume inside it.
  - `maxDistance` (default 100).
  - `rolloff: "linear" | "inverse" | "exponential"`, mapped to the panner's `distanceModel`, `refDistance`, `maxDistance` and `rolloffFactor`.
  - `pitch` (playback rate) for every source.
  - Spatial sources follow their node each frame while playing.
- **One-shots:** `Audio.playOneShot(clip, { volume?, position?, pitch?, minDistance?, maxDistance? })`. With a `position`, the sound plays spatially at that point.
- **Worlds.** Only the World that has the view plays sound; others are silent, as rendering already works. Servers never touch Howler, since it's imported lazily, as today.
- **0006** is amended: three's `PositionalAudio` is not used.

## Alternatives considered

- **three.js `PositionalAudio`** (0006's plan). It needs a three `AudioListener` on a three camera, which is render-backend state, and a second Web Audio graph beside Howler's.
- **Raw Web Audio.** Howler already handles unlocking, format fallback and pooling. We'd rebuild that.

## Consequences

**Positive**
- Positional sound with a few fields, with no new dependency.

**Negative / costs**
- HTML5-streamed clips (the `stream` import setting) can't be spatial. Howler's spatial API needs Web Audio. Such sources play flat, with a warning.
- No mixer buses or reverb zones yet.

## Deprecates

- The "Spatial playback (three.js PositionalAudio) is not implemented yet" note on `AudioSource`.

## Open questions

- Mixer buses (music, effects) with volumes in settings.

## References

- Howler spatial plugin: https://github.com/goldfire/howler.js#plugin-spatial
- `src/engine/audio/AudioSource.ts`, 0006
