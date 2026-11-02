// Browser smoke tests (ADR 0023): boot the production build of the editor (port 4174), with the
// samples copied beside it (ADR 0031), in Chromium (Windows Tauri webview) and WebKit (macOS/Linux
// Tauri webviews). The Flappy sample plays through the editor's Play mode (sample.spec.ts).
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  // Every test renders WebGL; too many at once starve headless pages of animation frames.
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4174",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      command: "npm run build:editor && npx vite preview --config vite.editor.config.ts --port 4174 --strictPort",
      url: "http://localhost:4174/editor.html",
      reuseExistingServer: false, // a reused server would serve a stale build: the command is what rebuilds
      timeout: 120_000,
    },
  ],
});
