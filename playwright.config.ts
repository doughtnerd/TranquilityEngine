// Browser smoke tests (ADR 0023): boot the production build of the editor (port 4174, or E2E_PORT
// so several checkouts can run at once; specs use URLs relative to baseURL), with the
// samples copied beside it (ADR 0031), in Chromium (Windows Tauri webview) and WebKit (macOS/Linux
// Tauri webviews). The Flappy sample plays through the editor's Play mode (sample.spec.ts).
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4174);

// Headless Chromium renders WebGL in software (SwiftShader) by default, and every test renders
// continuously, so CPU is what limits the suite: more workers only made each test slower. With the
// machine's GPU through ANGLE, Chromium's tests take about 40% less time each and the suite scales
// with workers. Locally on Windows (Direct3D 11) only, where it's measured; other platforms can add
// their ANGLE backend here. CI machines have no GPU, and E2E_SOFTWARE_GL=1 turns it off. WebKit
// has no such switch and stays on the CPU.
//
// On the GPU the engine gets a WebGPU device (Dawn on Direct3D 12). Playwright's headless shell
// doesn't ship dxcompiler.dll, so Dawn's default shader compiler (DXC) fails to load and
// requestDevice throws ("dxcompiler.dll Windows Error: 87"), which failed ~90 specs.
// `use_dxc` off makes Dawn compile with FXC (d3dcompiler_47.dll, part of Windows) instead.
const gpuAngle = process.env.CI || process.env.E2E_SOFTWARE_GL || process.platform !== "win32" ? null : "d3d11";
const chromiumArgs = gpuAngle ? ["--enable-gpu", `--use-angle=${gpuAngle}`, "--ignore-gpu-blocklist", "--disable-dawn-features=use_dxc"] : [];

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  // Every test renders WebGL; too many at once starve headless pages of animation frames (WebKit
  // renders on the CPU). With Chromium on the GPU, 8 workers run cleanly: the suite took 153 s,
  // against 261 s with 4 workers and software GL (whose tests only slowed down with more workers).
  workers: process.env.CI ? 2 : gpuAngle ? 8 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: chromiumArgs } } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
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
