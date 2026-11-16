// Storybook (ADR 0219): the editor's UI component library. Stories live beside their component as `*.stories.tsx` and
// are built with the editor's own Vite settings (.storybook/vite.config.ts, `componentViteConfig`), so a component
// resolves and compiles as it does in the editor: tsc through `typescriptTranspile()` (standard decorators, Preact JSX)
// with oxc off, the `"myco"` alias, ES-module workers (the profiler's capture Worker) and the engine's declarations.
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/preact-vite";

const config: StorybookConfig = {
  framework: {
    name: "@storybook/preact-vite",
    options: { builder: { viteConfigPath: fileURLToPath(new URL("./vite.config.ts", import.meta.url)) } },
  },
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-vitest"],
  core: { disableTelemetry: true },
};

export default config;
