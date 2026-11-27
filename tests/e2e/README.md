# Browser tests (Playwright)

The editor's end-to-end specs (ADR 0023). They run the production build of the editor, served by
`scripts/e2e-server.mjs`, which rebuilds it only when its sources changed since the last e2e build
(`E2E_REBUILD=1` forces it). One server and one build serve every worker.

## Commands

| Command | Runs |
| --- | --- |
| `npm run test:e2e` | The everyday run: Chromium, every spec not tagged `@slow`. |
| `npm run test:e2e:slow` | Chromium, only the `@slow` specs. |
| `npm run test:e2e:chromium` | Both Chromium halves. |
| `npm run test:e2e:webkit` | WebKit, both halves (on demand: WebKit renders on the CPU). |
| `npm run test:e2e:all` | Every project. |
| `npm run test:e2e:install` | Fetches Chromium and WebKit, once. |

Arguments pass through: `npm run test:e2e -- assetbrowser` runs one file, `-- assetbrowser.spec.ts:27`
one test. A `@slow` spec isn't in the default project: run it with `npm run test:e2e:slow -- thumbnails`.
Concurrent runs (another checkout, a master worktree) need their own `E2E_PORT`.

## What's tagged `@slow`

Specs that take long and whose code rarely changes: the game exports (`export.spec.ts`,
`animation-export.spec.ts`), asset thumbnails and live previews (`thumbnails.spec.ts`), the Navigation
sample's Play session, the lobby view, the sky bake and the HDR environment. Tag a test with
`{ tag: "@slow" }` after its title (or on a `test.describe`). Run `test:e2e:slow` before merging changes
to what they cover.

`@webkit` marks the smoke a WebKit run should cover first (the animation runtime,
`animation-runtime.spec.ts`): `npm run test:e2e:webkit` runs every untagged and `@webkit` spec anyway;
`npm run test:e2e:webkit -- --grep @webkit` runs just those.

## Software GL

Locally on Windows, Chromium renders on the GPU (`tests/e2e/gpu.ts`). Elsewhere, and in CI or with
`E2E_SOFTWARE_GL=1`, it renders with SwiftShader, where every frame is CPU work in the GPU process
and the CPU is what limits the suite. For that case (the last three apply on the GPU too):

- **Frame cap.** Specs import `test` and `expect` from `./fixtures`, whose init script caps render
  loops (a `requestAnimationFrame` callback requested again after it has run) at `E2E_FPS` frames
  a second, default 10, in Play mode and outside the editor, and at `E2E_EDIT_FPS`, default 5, while
  the editor edits. A new callback (an "after the next frame", such as Preact's effects) still runs
  on the next real frame. Play keeps 10 because a World steps at most `maxFrameTime` (0.1 s) a
  frame. `E2E_FPS=0` turns the cap off; a spec that measures timing in frames raises it with
  `test.use({ fps: fpsAtLeast(30) })`.
- **Half device scale.** Chromium renders at `deviceScaleFactor` 0.5 (`E2E_SCALE`): the layout is
  the same in CSS pixels, canvases have a quarter of the pixels.
- **One worker per core**, up to 8.
- **No trace per test.** Traces are recorded on CI's retry of a failure only; rerun a failure
  locally with `--trace on`.
- **No Code panel warm-up.** An open project doesn't load Monaco and its TypeScript worker in the
  background (`codePreload: false` stores the user's setting, Settings > General > Code, as off before the editor
  loads); opening a file or pressing Play loads it. A spec that tests the
  warm-up sets `test.use({ codePreload: true })`.
- **No compression.** `scripts/e2e-server.mjs` serves `dist/editor/` as it is (`vite preview`
  gzipped every script for every test's fresh browser context).

In a 4-core cloud container this took the default run from 29.5 minutes (91 of 216 tests failing,
mostly timeouts) to 9.5; the `@slow` specs take 2 minutes. Prefiltering the default studio environment with 256 samples a texel instead of Babylon's 4096
(`src/engine/render/babylon/studioCube.ts`) then took it to about 5.3 minutes: at 4096 it cost each project open
about 6.5 s of CPU. The default test timeout is 45 s with
software GL (30 s on the GPU).

Each project a page opens costs seconds of CPU (its renderer starts, compiling pipelines), so specs
open as few as they need: `openEditor(page, { files })` opens the writable Flappy folder straight
from the start screen rather than after booting the read-only sample.

## Opening the editor (ADR 0330)

`fixtures.ts` opens the editor one way, and says once when it has booted:

- `openEditor(page, { sample: "playground3d" })` opens a read-only sample (`?sample=`); `LAB` is the
  Sound Lab. `openEditor(page, { files })` opens the writable test project: the Flappy sample in memory
  with `files` (project path → text, or a `Uint8Array` for a clip or model) written over it; what the
  editor writes is read back through `window.testFolder`. Options: `viewport` (set before the editor
  loads), `audioBackend` (a sample's audio.json answered with another audio backend), and the boot
  options below.
- Both wait for boot: the edit World has stepped more than 10 frames (`frames` changes it, `timeout`
  how long to wait). After a reload, or a project opened from the start screen (`installFakeFolders`,
  then Open Project…), call `waitForEditor(page)` alone.
- `playWithAudio(page, { backend, startTimeout })` presses Play, clicks the game view (the gesture
  that unlocks audio) and waits until `Audio.debug()` reports audio running on that backend (default
  the core); `readAudioDebug<T>(page)` reads `Audio.debug()` as the spec's own type.
- `Hooks` is the one type of the editor's debug hooks on `window` (`engine`, `playEngine`, `orbit`,
  `overlayHandles`, `nodeRect`, `testFolder`): page callbacks cast `window as unknown as Hooks`. Don't
  declare another.

## Writing specs

- Import from `./fixtures`, not `@playwright/test`.
- Wait for conditions, not time: `expect.poll`, `waitForFunction`, `afterFrames(page)` after moving
  the camera from a test, `play(page)` to start Play mode (it type-checks scripts first). Keep
  `waitForTimeout` for checking that something *doesn't* happen.
- A test that needs WebGPU takes the `webgpu` fixture and calls `requireWebGPU(webgpu)` first, so it
  skips before booting the editor where there's no adapter (software GL, WebKit).
- Typing into something that takes focus in an effect (a search box that just opened): wait for
  `toBeFocused()` first.
- Read the running game through the public `myco` API, never engine internals (`_world`,
  `_componentsOfType`…): `inLiveWorld(page, world, fn)` (`./liveWorld`) hands `fn` a World of the
  play Engine (the default World for `null`, another by name, once it has stepped a frame), found
  the way a script finds it (a system's `ctx.world`), and walks nodes through `root`, `children`
  and `getComponents`. View and input state come from the game view's tiles and Worlds strip.
- **Baseline captures:** `ui-css.spec.ts` is the one spec that compares captures with committed images (Playwright's
  `toHaveScreenshot`, in `ui-css.spec.ts-snapshots/`, named per project and platform: the committed ones are Linux with
  software GL). After an intended change to UI drawing, look at the new images and update them with
  `npx playwright test --project=chromium ui-css --update-snapshots`; a new platform or the GPU writes its own on its
  first run. Its frame-time tests (`@slow`) read play mode's Stats overlay and hold the UI under the tripwires in the spec.
- Never read the renderer (`world.render`, its diagnostics or editor viewport) from a page: it is
  internal (CLAUDE.md). Check what it draws from captures (`./viewCapture`: `captureView`,
  `captureArea`, `steadyView`, `pixelsChanged`, `pixelsNear`), the editor's UI (the particle preview's
  stats, the camera preview inset, the canvas's drawing-buffer size), or `nodeRect`; what only the
  renderer knows (composers, cascades, probe captures, program counts) belongs in a unit test of the
  render module through its own interface (`renderDiagnostics(world)`, `BabylonSurface`,
  `planFrame`, the material library).
