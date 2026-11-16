import { defineConfig } from "vitest/config";
import { MYCO_ALIASES, engineTypes, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  // Sample scripts (ADR 0031) import the engine as "myco", as project scripts do.
  resolve: { alias: MYCO_ALIASES },
  test: {
    environment: "node",
    // Headless unit tests only: stories (`*.stories.tsx`) run in a browser through vitest.stories.config.mts (ADR 0219).
    include: ["src/**/*.test.ts"],
    // First-party runtime plugins active, as in the player (ADR 0135).
    setupFiles: ["./src/plugins/testSetup.ts"],
    // `npm run bench` (vitest bench): ECS benchmarks, never part of `npm test`.
    benchmark: { include: ["bench/**/*.bench.ts"] },
  },
});
