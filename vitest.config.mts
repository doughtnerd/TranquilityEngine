import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";
import { MYCO_ALIASES, engineTypes, svelteUI, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [svelteUI(), typescriptTranspile(), engineTypes()],
  oxc: false,
  // Sample scripts (ADR 0031) import the engine as "myco", as project scripts do.
  resolve: { alias: MYCO_ALIASES },
  // Svelte picks its client runtime with the custom renderer (ADR 0423) through this condition; in Node it's required,
  // or `svelte/renderer` resolves to its server stub.
  ssr: { resolve: { conditions: ["svelte-custom-renderer", ...defaultServerConditions], externalConditions: ["svelte-custom-renderer"] } },
  test: {
    environment: "node",
    // Headless unit tests only: stories (`*.stories.tsx`) run in a browser through vitest.stories.config.mts (ADR 0219).
    include: ["src/**/*.test.ts"],
    // First-party runtime plugins active, as in the player (ADR 0135).
    setupFiles: ["./src/plugins/testSetup.ts"],
    // Svelte goes through Vite (not Node's resolver), so the condition above applies to it.
    server: { deps: { inline: [/[\\/]svelte[\\/]/] } },
    // `npm run bench` (vitest bench): ECS benchmarks, never part of `npm test`.
    benchmark: { include: ["bench/**/*.bench.ts"] },
  },
});
