# 0006. Audio: Howler + three.js positional audio

- **Status:** Superseded by 0149 (an engine-owned Rust audio core replaces Howler); was amended by 0074
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010

## Context

The legacy engine plays audio through Howler (`AudioPlayer.js`, `AudioManager.js`); it was recently fixed ("Audio works again"). It has no positional/3D audio. `package.json` also contains audio packages from an earlier terminal-game version of the project (`play-sound`, `soundjs`) that the engine doesn't use.

Howler is good at loading, format fallback, sprites, pooling, fades and unlocking audio on browser autoplay rules. three.js has `AudioListener`, `Audio` and `PositionalAudio`, which follow `Object3D`s in the scene. Both are built on Web Audio.

## Decision

- **Howler** handles non-spatial audio: music, UI sounds, 2D sound effects, loading, and autoplay unlocking.
- **three.js `PositionalAudio`** handles spatial audio attached to nodes in 3D (and optionally 2D) scenes.
- Both share **one `AudioContext`**: the engine creates Howler's context and hands it to three.js (`THREE.AudioContext.setContext(Howler.ctx)`), so there is one output, one master volume and one unlock step.
- Game code sees engine components, not the libraries:
  - `AudioListener`: usually on the active camera node.
  - `AudioSource`: a clip, volume, loop and a `spatial` flag; it picks Howler or PositionalAudio internally.
  - `Audio` static API for one-shots and music (`Audio.playOneShot(clip)`, `Audio.music.play(clip)`).
- Mixer buses (master, music, sfx, ui) are engine-level `GainNode`s on the shared context.

## Alternatives considered

- **Howler only, with its spatial plugin.** One library, but its spatial positions must be pushed by hand and it doesn't integrate with the three.js scene graph.
- **three.js audio only.** Follows the scene graph for free, but lacks Howler's loading, format fallback, sprites and unlock handling.
- **Raw Web Audio.** Maximum control, most work.

## Consequences

**Positive**
- Spatial audio follows nodes automatically through the render sync (0010).
- One volume/mute model and one unlock prompt.

**Negative / costs**
- Two libraries to keep compatible on one context; context sharing must be verified on all Tauri webviews.
- `AudioSource` must hide which backend plays a clip.

## Deprecates

- `src/engine/AudioPlayer.js` and `src/assets/behaviors/AudioManager.js`: replaced by `AudioSource` / `AudioListener` / `Audio`.
- Unused dependencies: `play-sound`, `soundjs`.

## Open questions

- Whether 2D games should use spatial panning (stereo by x position) by default.

## References

- https://howlerjs.com/
- https://threejs.org/docs/#api/en/audio/PositionalAudio
