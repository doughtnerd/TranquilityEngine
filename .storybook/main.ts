// Storybook (ADR 0219): the editor's UI component library. Stories live beside their component as `*.stories.tsx` and
// are built with the editor's own Vite settings (`componentViteConfig`), so a component resolves and compiles as it does
// in the editor: tsc through `typescriptTranspile()` (standard decorators, Preact JSX) with oxc off, the `"myco"` alias,
// ES-module workers (the profiler's capture Worker) and the engine's type declarations.
import type { StorybookConfig } from "@storybook/preact-vite";
import { mergeConfig } from "vite";
import { componentViteConfig } from "../vite.shared.ts";

const config: StorybookConfig = {
  framework: { name: "@storybook/preact-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-vitest"],
  core: { disableTelemetry: true },
  viteFinal: (vite) => mergeConfig(vite, componentViteConfig()),
};

export default config;
