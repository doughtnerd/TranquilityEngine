// Story tests (ADR 0219): every story in `src/**/*.stories.tsx` runs as a test, its `play` function included, in headless
// Chromium through Vitest's browser mode (Playwright provider), with the editor's Vite settings (`componentViteConfig`:
// tsc through `typescriptTranspile()`, oxc off, the `"myco"` alias, ES-module workers). `npm run test:stories` runs it;
// `npm test` (vitest.config.mts) stays headless under Node and never collects a story.
import { fileURLToPath } from "node:url";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import type { PluginOption } from "vite";
import { defineConfig } from "vitest/config";
import { componentViteConfig } from "./vite.shared.ts";

const editor = componentViteConfig();
const own = new Set((editor.plugins as Array<{ name: string }>).map((p) => p.name));

/** Storybook's plugins without the copies of ours its `viteFinal` (.storybook/main.ts) adds: each runs once. */
async function storybookPlugins(): Promise<PluginOption[]> {
  const flat = (list: unknown[]): unknown[] => list.flatMap((p) => (Array.isArray(p) ? flat(p) : [p]));
  const plugins = flat(await storybookTest({ configDir: fileURLToPath(new URL("./.storybook", import.meta.url)) }));
  return plugins.filter((p) => !(p && typeof p === "object" && "name" in p && own.has((p as { name: string }).name))) as PluginOption[];
}

export default defineConfig({
  ...editor,
  plugins: [...(editor.plugins ?? []), ...(await storybookPlugins())],
  test: {
    name: "stories",
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
