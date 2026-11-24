# FAQ

Short answers to common questions. Each links to the guide that covers the topic in full.

## Getting started

### How do I run the editor?

Run `npm install`, then `npm run dev`. The editor is at `http://localhost:3000/editor.html`. Add `?sample=flappy` to open the Flappy Bird sample. See [The editor](guide/editor.md).

### What is Myco Engine?

A 2D and 3D game engine in TypeScript. Scripts are Unity-style behaviors with lifecycle methods, scenes are node graphs, and rendering uses Babylon.js. The desktop editor ships through Tauri.

### Is there a sample project to learn from?

Yes. `samples/flappy/` is a small 2D game, and `samples/arena/` is a multiplayer game. Open either from the editor's start screen. See [Multiplayer](guide/multiplayer.md).

## Editor

### Why can't I save in the browser editor?

In a browser the editor opens samples read-only. Run the desktop editor with `npm run tauri:dev` to open a project folder, use **Make a Copy…** to copy a sample, and save with Ctrl+S. See [The Projects window](guide/editor.md#the-projects-window).

### Can I rearrange the panels?

Yes. Panels can be closed, added, copied, saved as layouts and detached into their own windows. See [Docks and panels](guide/editor.md#docks-and-panels) and [Layouts](guide/editor.md#layouts).

### What is the `.myco/` folder?

Editor data kept beside your project, such as history and thumbnails. Game builds leave it out. See [The `.myco/` folder](guide/editor.md#the-myco-folder).

## Scripting

### How do I write a script?

Write a TypeScript class that extends `GameBehavior` and import from `"myco"`. It gets lifecycle methods such as `update`, `fixedUpdate` and `lateUpdate`. The Physics guide has an example in [Character controllers](guide/physics.md#character-controllers-adr-0091).

### Which way is forward, and are angles in degrees?

Coordinates are left-handed with +Z forward, as in Unity. Rotations are quaternions, and Euler angles are in radians (ZXY order). See [Transforms and rotation](guide/transforms.md).

### Can I add features with a plugin?

Yes. A plugin can add components, systems, asset kinds, editor panels and Inspector extras. The plugin SDK is experimental, and plugins run with the same access as your scripts. See [Writing a plugin](guide/plugins.md).

## Rendering

### Which renderer does the engine use?

Babylon.js is the only renderer. It does not appear in the public API, so your scripts use `myco` types only. See [Materials, shaders and batching](guide/materials-and-shaders.md).

### Can I write my own shaders?

Yes. Hand-written shader assets can be WGSL or GLSL, with keywords and variants. See [Hand-written shaders](guide/materials-and-shaders.md#hand-written-shaders).

### How do I add a sky, water or decals?

Set an `Environment` map for a [sky](guide/skies.md), add a `WaterSurface` for [water](guide/water.md#adding-water), and use `DecalProjector` or `Decal2D` for [decals](guide/decals.md). Lines and trails are in [Lines and trails](guide/lines-and-trails.md).

## Audio

### Why is there no sound?

Browsers keep audio locked until the player clicks, taps or presses a key. If that is not it, read `Audio.debug()`. The page [Why is there no sound?](guide/why-no-sound.md) walks through each cause, starting with [a locked status](guide/why-no-sound.md#1-status-is-locked).

### Which sound formats can I use?

WAV, FLAC, MP3 and Ogg Vorbis play everywhere. AAC plays once you turn it on in `audio.json`. Opus and AIFF are not supported. See [Sound files](guide/playing-sound.md#sound-files).

### How do I play a sound from a script?

Use `Audio.playOneShot("sfx/jump.wav")` for a fire-and-forget sound, or an `AudioSource` component for a sound on a node. See [Playing sound](guide/playing-sound.md).

## Physics

### Does the engine have 2D and 3D physics?

Yes, both run on Rapier. A scene's `"physics"` setting picks the dimension. See [Bodies and colliders](guide/physics.md#bodies-and-colliders).

### Are there joints and character controllers?

Yes. See [Character controllers](guide/physics.md#character-controllers-adr-0091) and [Joints](guide/physics.md#joints-adr-0092).

## Multiplayer

### How does multiplayer work?

It is server-authoritative. The server runs a World tagged `server`, clients run Worlds tagged `client`, and the engine handles replication, inputs and client prediction. See [Multiplayer](guide/multiplayer.md) and [Worlds](guide/worlds.md).

### How do I run a dedicated server?

Run `npm run server -- path/to/project`. Flags such as `--port` and `--max-connections` are listed in [The dedicated server](guide/multiplayer.md#the-dedicated-server).

## Building and exporting

### How do I export a game?

Use **Build and Export…** in the editor's File menu, or run `npm run export -- <projectDir> [--out DIR] [--target web|desktop]`. A web export is served with `node serve.mjs`; a desktop export is wrapped in a Tauri app. See [The menu bar](guide/editor.md#the-menu-bar).

### Why does the desktop build fail on Windows?

The desktop app needs Rust with the MSVC toolchain and a recent CMake. See [Building the desktop app on Windows](guide/editor.md#building-the-desktop-app-on-windows) for fixes to the common SDL3 failures.

## Platforms

### Where do the editor and games run?

The editor runs on desktop and in a web browser. Games run on the web, on desktop and on Android through Tauri. See [Audio core minimum versions](guide/audio-minimum-versions.md) for the browser and WebView versions the audio core needs.
