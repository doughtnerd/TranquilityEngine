# Home

Myco Engine is a 2D and 3D game engine for TypeScript. You write Unity-style behaviors on GameObjects arranged in a node graph, the engine renders with Babylon.js, and the editor runs on the desktop (Tauri) or in a browser. Games ship to the web, the desktop and Android.

The engine is in active development. These pages describe what's on `master` today. Anything not described here may be missing or may change.

## Getting started

1. Install Node.js, then clone the repository and run:

   ```shell
   npm install
   npm run dev
   ```

2. Open http://localhost:3000/editor.html. The editor opens on its start screen. Open the **Flappy Bird** sample and press **Play** (space, up arrow or click to flap).
3. In a browser the editor opens samples read-only. For the desktop editor run `npm run tauri:dev`; it needs [Rust](https://rustup.rs/) for [Tauri](https://v2.tauri.app/). There, **Make a Copy…** copies a sample into a folder you can edit and save.
4. Read [The editor](guide/editor.md) for the windows and panels, then [Worlds](guide/worlds.md) and [Transforms and rotation](guide/transforms.md) for how a game is put together.

To build a game for players, run `npm run build` once, then `npm run export -- <projectDir> --target web` (or `--target desktop`).

## Guides

| Area | Pages |
| --- | --- |
| Basics | [The editor](guide/editor.md) · [Worlds](guide/worlds.md) · [Transforms and rotation](guide/transforms.md) · [Writing a plugin](guide/plugins.md) · [The debug link](guide/debug-link.md) |
| Gameplay | [Input](guide/input.md) · [Physics](guide/physics.md) · [Navigation](guide/navigation.md) · [Tilemaps](guide/tilemaps.md) · [Game UI](guide/ui.md) · [Animation](guide/animation.md) · [Animation performance](guide/animation-performance.md) · [Multiplayer](guide/multiplayer.md) |
| Rendering | [Materials, shaders and batching](guide/materials-and-shaders.md) · [Skies](guide/skies.md) · [Water](guide/water.md) · [Decals](guide/decals.md) · [Lines and trails](guide/lines-and-trails.md) · [2D lighting](guide/2d-lighting.md) · [Fog, camera rays and spatial audio](guide/atmosphere-and-sound.md) |
| Audio | [Playing sound](guide/playing-sound.md) · [Why is there no sound?](guide/why-no-sound.md) · [Playlists](guide/playlists.md) · [Interactive music](guide/interactive-music.md) · [Sound generators](guide/sound-generators.md) · [Spatial audio](guide/spatial-audio.md) · [Audio mixer](guide/audio-mixer.md) · [Live mixing and ducking](guide/audio-mixing.md) · [Loudness](guide/audio-loudness.md) · [Audio profiler](guide/audio-profiler.md) · [Audio takes](guide/audio-takes.md) · [Audio mix API](guide/audio-mix-api.md) · [Minimum versions](guide/audio-minimum-versions.md) |

## Reference

- [API reference](API-Reference): every class, function and type the `myco` module exports, generated from the source.
- [FAQ](FAQ.md): short answers that point into the guides.
- [News](News.md): what changed recently, newest first.

## For contributors

Design decisions, plans and architecture notes stay in the repository: start at [docs/README.md](https://github.com/doughtnerd/TranquilityEngine/blob/master/docs/README.md). This wiki is built from [`docs/wiki/`](https://github.com/doughtnerd/TranquilityEngine/tree/master/docs/wiki), so change a page there in a pull request; edits made on the wiki itself are not kept.
