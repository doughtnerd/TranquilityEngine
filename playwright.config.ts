// Browser smoke tests (ADR 0023): boot the production build of the editor (port 4174, or E2E_PORT
// so several checkouts can run at once; specs use URLs relative to baseURL), with the
// samples copied beside it (ADR 0031), in Chromium (Windows Tauri webview) and WebKit (macOS/Linux
// Tauri webviews). The Flappy sample plays through the editor's Play mode (sample.spec.ts).
//
// Projects: `chromium` is the everyday run (`npm run test:e2e`); specs tagged @slow (slow ones
// whose code rarely changes: game exports, thumbnails, long play sessions) run in `chromium-slow`
// (`npm run test:e2e:slow`); WebKit runs on demand (`npm run test:e2e:webkit`, both halves).
// `npm run test:e2e:all` runs every project. Specs import `test` from tests/e2e/fixtures.ts, which
// caps render loops' frame rate with software GL.
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { chromium, defineConfig, devices } from "@playwright/test";
import { gpuAngle } from "./tests/e2e/gpu";

const port = Number(process.env.E2E_PORT ?? 4174);

// Headless Chromium renders WebGL in software (SwiftShader) by default, and every test renders
// continuously, so CPU is what limits the suite: more workers only made each test slower. With the
// machine's GPU through ANGLE, Chromium's tests take about 40% less time each and the suite scales
// with workers. Locally on Windows (Direct3D 11) only, where it's measured (tests/e2e/gpu.ts); other
// platforms can add their ANGLE backend there. CI machines have no GPU, and E2E_SOFTWARE_GL=1 turns
// it off. WebKit has no such switch and stays on the CPU.
//
// On the GPU the engine gets a WebGPU device (Dawn on Direct3D 12). Playwright's headless shell
// doesn't ship dxcompiler.dll, so Dawn's default shader compiler (DXC) fails to load and
// requestDevice throws ("dxcompiler.dll Windows Error: 87"), which failed ~90 specs.
// `use_dxc` off makes Dawn compile with FXC (d3dcompiler_47.dll, part of Windows) instead.
// With software GL the cost of a frame is SwiftShader filling pixels in the GPU process (the
// page's own work is about a millisecond a frame), so pages render at half the device scale: the
// layout is the same in CSS pixels and canvases have a quarter of the pixels (the Flappy scene view
// went from 11 to 50 frames a second, the 3D Playground from 5 to 11). E2E_SCALE overrides it.
const scale = Number(process.env.E2E_SCALE ?? (gpuAngle ? 1 : 0.5));
const chromiumArgs = gpuAngle ? ["--enable-gpu", `--use-angle=${gpuAngle}`, "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"] : [];
// A machine with another Chromium build than this Playwright's (cloud containers ship one in
// /opt/pw-browsers) uses that one when Playwright's own isn't installed; E2E_CHROMIUM picks one.
const chromiumPath = process.env.E2E_CHROMIUM ?? (!existsSync(chromium.executablePath()) && existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const chromiumUse = { ...devices["Desktop Chrome"], deviceScaleFactor: scale, launchOptions: { args: chromiumArgs, ...(chromiumPath ? { executablePath: chromiumPath } : {}) } };
const webkitUse = { ...devices["Desktop Safari"] };
const slow = /@slow/;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  // Every test renders WebGL; too many at once starve headless pages of animation frames (WebKit
  // renders on the CPU). With Chromium on the GPU, 8 workers run cleanly: the suite took 153 s,
  // against 261 s with 4 workers and software GL. With software GL the CPU is the limit: one worker
  // per core (up to 8), with render loops capped (fixtures.ts) so each page leaves CPU to the rest.
  workers: process.env.CI ? 2 : gpuAngle ? 8 : Math.min(8, Math.max(2, availableParallelism())),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", grepInvert: slow, use: chromiumUse },
    { name: "chromium-slow", grep: slow, use: chromiumUse },
    { name: "webkit", grepInvert: slow, use: webkitUse },
    { name: "webkit-slow", grep: slow, use: webkitUse },
  ],
  webServer: [
    {
      // Rebuilds the editor only when its sources changed since the last e2e build (E2E_REBUILD=1 forces it), then serves it.
      command: `node scripts/e2e-server.mjs`,
      env: { E2E_PORT: String(port) },
      url: `http://localhost:${port}/editor.html`,
      reuseExistingServer: false, // a reused server could serve a stale build: the command is what checks it
      timeout: 120_000,
    },
  ],
});
