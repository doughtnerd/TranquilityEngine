// Story tests (ADR 0219): every story in `src/**/*.stories.tsx` runs as a test, its `play` function included, in headless
// Chromium through Vitest's browser mode (Playwright provider), with the editor's Vite settings (`componentViteConfig`:
// tsc through `typescriptTranspile()`, oxc off, the `"myco"` alias, ES-module workers). `npm run test:stories` runs it;
// `npm test` (vitest.config.mts) stays headless under Node and never collects a story.
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import { componentViteConfig } from "./vite.shared.ts";

export default mergeConfig(
  componentViteConfig(),
  defineConfig({
    plugins: [storybookTest({ configDir: fileURLToPath(new URL("./.storybook", import.meta.url)) })],
    test: {
      name: "stories",
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
      },
    },
  }),
);
