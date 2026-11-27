# News

Update notes, newest first. Decision records for each change live in the repository under `docs/decisions/`.

## 2026-11-26 — Game UI is Svelte; UI documents retired

Game UI is written as Svelte 5 components (`*.svelte`) and shown by a `UIView`: HTML tags, a `<style>`, props, runes and bindings, rendered onto the engine's UI. UI documents (`*.ui.xml`, `*.ui.css` and the `UIDocument` component) are gone: a scene that still saves a `UIDocument` fails to load and says so. **Create > UI > UI View** adds a view on a new component. See [Game UI](guide/ui.md).

## 2026-11-24 — Decals, lines and trails, and prefab fixes

`DecalProjector` and `Decal2D` put bullet holes, scorch marks and footprints onto surfaces, and `Decals.project` spawns them from scripts. See [Decals](guide/decals.md). `LineRenderer` and `TrailRenderer` draw ribbons in 2D and 3D with widths, gradients and Edit Points in the scene view. See [Lines and trails](guide/lines-and-trails.md).

Create Prefab now keeps references to scene nodes as overrides on the new instance, as Unity does. Painted tile variants no longer reshuffle their neighbours: they come from a hash of the cell and the Tilemap's `variantSeed`. See [Tilemaps](guide/tilemaps.md).

## 2026-11-24 — Smaller fixes

UI elements stop the pointer by `raycastTarget`, as in Unity, so a click on a transparent element passes through. See [Game UI](guide/ui.md#the-pointer-goes-to-ui-first). A directional light flagged `sun` is the World's sun for skies and shader graphs. See [Skies](guide/skies.md). Fallback-language messages use their own language's plural rules, and several input and UI bugs are fixed.

## 2026-11-23 — Animation

The animation system arrives as a first-party plugin. It has the `Animator`, property tracks, tweens and timelines, graphs with state machines and blend spaces, IK, retargeting, motion matching and ragdolls. The editor gets an Animation window with record mode. See [Animation](guide/animation.md).

## 2026-11-23 — Debug link pairing

Tools can connect to a running game on the same network with a short pairing code, over WebSocket or WebRTC. This includes exported games and Android builds. See [The debug link](guide/debug-link.md).

## 2026-11-23 — Editor changes

The Worlds panel shows your Worlds as a node graph you can pan, zoom and rewire. See [The Worlds panel](guide/worlds.md#the-worlds-panel). The Create menus group items into categories, panel tabs reorder by dragging, and the scene tools and Play bar use icon buttons. The desktop app opens on a launcher that leads to the Projects window. Desktop export makes app icons when a project has none.

## 2026-11-22 — Playlists, sound generators and takes

Playlists replace audio events. A `*.playlist.json` file holds Clip, Queue, Switch, Blend, Layer and Sequence entries, played with `Audio.play`. See [Playlists](guide/playlists.md) and [Interactive music](guide/interactive-music.md). Sound generators (oscillators, synths and sfxr-style blips) are a playlist entry kind. See [Sound generators](guide/sound-generators.md). Takes record a run so you can replay it in the Audio Studio. See [Audio takes](guide/audio-takes.md).

## 2026-11-22 — Localisation and subtitles

Text is localised through keyed string tables, with ICU message formatting and fallback languages. Subtitles come from the same tables and can be shown by a built-in display. Localised audio lives in per-language folders, and voice-over plays by key.

## 2026-11-22 — Game UI focus navigation

Game UI has one focused element per World. Keyboard and gamepad move focus with `navigate`, `submit`, `cancel`, `next` and `previous` actions. See [Keyboard and gamepad navigation](guide/ui.md#keyboard-and-gamepad-navigation).

## 2026-11-22 — Input guide and unreliable multiplayer messages

The [Input guide](guide/input.md) covers actions, contexts, players and pawns, rebinding, prompts and gamepads. Multiplayer can send unreliable messages over WebRTC data channels, and snapshots are split into datagram-sized parts. See [WebRTC for unreliable messages](guide/multiplayer.md#webrtc-for-unreliable-messages).

## 2026-11-16 — Audio Studio

The Audio Studio is a second app, opened from the editor or shipped on its own, with its own Profiler. Its screens adapt to screen size and touch. See [Audio profiler](guide/audio-profiler.md).

## 2026-11-13 — Profiler, loudness and live mixing

The Audio Profiler records a session and saves it as a `.sporesample` file. Loudness meters measure M, S, I, LRA and true peak against targets that warn and never adjust. You can mix while Play runs. See [Audio profiler](guide/audio-profiler.md), [Loudness](guide/audio-loudness.md) and [Live mixing and ducking](guide/audio-mixing.md).

## 2026-11-12 — Interactive music

Music runs on a musical clock with beat and bar transitions, stingers and markers. See [Interactive music](guide/interactive-music.md).

## 2026-11-11 — Spatial audio and coordinates

Spatial audio adds beds, reverb zones, occlusion with materials, Doppler and ambisonic clips. See [Spatial audio](guide/spatial-audio.md). The [Transforms guide](guide/transforms.md) explains the left-handed, +Z-forward coordinates and radians.

## 2026-11-10 — A new audio core

Audio runs on an engine-owned core in an AudioWorklet, with the Babylon backend as a fallback. See [Playing sound](guide/playing-sound.md) and, if you hear nothing, [Why is there no sound?](guide/why-no-sound.md).

## 2026-11-08 — Plugins

Third-party plugins load from your project folder or from npm packages. First-party features such as Tilemaps and Particles are plugins too. See [Writing a plugin](guide/plugins.md).

## 2026-11-07 — Skies, tilemaps, physics and materials

Procedural skies with time of day, tilemaps with auto-tiling and one-way platforms, and 2D and 3D physics with joints and character controllers. Hand-written WGSL and GLSL shaders and GPU instancing arrive too. See [Skies](guide/skies.md), [Tilemaps](guide/tilemaps.md), [Physics](guide/physics.md) and [Materials, shaders and batching](guide/materials-and-shaders.md).

## 2026-11-05 — Water, game UI and Babylon.js

Water surfaces with waves, foam and buoyancy, and a flexbox game UI with screen and world canvases. Rendering moves fully to Babylon.js. See [Water](guide/water.md) and [Game UI](guide/ui.md).

## 2026-11-04 — Navigation and the editor

Built-in navigation: bake in the editor or with `npm run nav:bake`, then drive agents from scripts. See [Navigation](guide/navigation.md) and [The editor](guide/editor.md).

## 2026-11-02 — Worlds and multiplayer

An Engine can run several Worlds, and multiplayer builds on that with server-authoritative replication, inputs and client prediction. See [Worlds](guide/worlds.md) and [Multiplayer](guide/multiplayer.md).
