import { defineConfig } from "vitest/config";
import { MYCO_ALIASES, typescriptTranspile } from "../../vite.shared.ts";
import { svelteUI } from "./svelteCompile.mjs";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelteUI(), typescriptTranspile()],
  oxc: false,
  resolve: {
    alias: MYCO_ALIASES,
    // svelte's package exports pick the client runtime and the renderer entry with this condition.
    conditions: ["svelte-custom-renderer", "module", "import", "default"],
  },
  ssr: { resolve: { conditions: ["svelte-custom-renderer", "module", "node", "import", "default"], externalConditions: ["svelte-custom-renderer"] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["../../src/plugins/testSetup.ts"],
    server: { deps: { inline: [/svelte/] } },
  },
});
