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

Specs that take long and whose code rarely changes: the game exports (`export.spec.ts`), asset
thumbnails and live previews (`thumbnails.spec.ts`), the Navigation sample's Play session, the lobby
view, the sky bake and the HDR environment. Tag a test with `{ tag: "@slow" }` after its title (or on
a `test.describe`). Run `test:e2e:slow` before merging changes to what they cover.

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
  background (`codePreload: false`); opening a file or pressing Play loads it. A spec that tests the
  warm-up sets `test.use({ codePreload: true })`.
- **No compression.** `scripts/e2e-server.mjs` serves `dist/editor/` as it is (`vite preview`
  gzipped every script for every test's fresh browser context).

In a 4-core cloud container this took the default run from 29.5 minutes (91 of 216 tests failing,
mostly timeouts) to 9.5; the `@slow` specs take 2 minutes. Prefiltering the default studio environment with 256 samples a texel instead of Babylon's 4096
(`src/engine/render/babylon/studioCube.ts`) then took it to about 5.3 minutes: at 4096 it cost each project open
about 6.5 s of CPU. The default test timeout is 45 s with
software GL (30 s on the GPU).

Each project a page opens costs seconds of CPU (its renderer starts, compiling pipelines), so specs
open as few as they need: `openTestProject(page, extra)` opens the writable Flappy folder straight
from the start screen rather than after booting the read-only sample.

## Writing specs

- Import from `./fixtures`, not `@playwright/test`.
- Wait for conditions, not time: `expect.poll`, `waitForFunction`, `afterFrames(page)` after moving
  the camera from a test, `play(page)` to start Play mode (it type-checks scripts first). Keep
  `waitForTimeout` for checking that something *doesn't* happen.
- A test that needs WebGPU takes the `webgpu` fixture and calls `requireWebGPU(webgpu)` first, so it
  skips before booting the editor where there's no adapter (software GL, WebKit).
- Typing into something that takes focus in an effect (a search box that just opened): wait for
  `toBeFocused()` first.
