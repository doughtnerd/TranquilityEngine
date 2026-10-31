// Browser smoke tests (ADR 0023): boot the production builds of the Flappy demo (port 4173)
// and the editor (port 4174) in Chromium (Windows Tauri webview) and WebKit (macOS/Linux Tauri
// webviews). The demo is driven through `window.flappy`, its state handle.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      command: "npm run build:game && npm run preview",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run build:editor && npx vite preview --config vite.editor.config.ts --port 4174 --strictPort",
      url: "http://localhost:4174/editor.html",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
