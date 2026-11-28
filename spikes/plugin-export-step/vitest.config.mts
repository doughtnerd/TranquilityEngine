// Spike-only vitest config (repo rule: typescriptTranspile with oxc: false). Run from the repo root:
//   npx vitest run --config spikes/plugin-export-step/vitest.config.mts --fsModuleCachePath /tmp/vitest-cache-spike-export
import { defineConfig } from "vitest/config";
import { MYCO_ALIASES, typescriptTranspile } from "../../vite.shared.ts";

export default defineConfig({
  root: new URL("../../", import.meta.url).pathname,
  plugins: [typescriptTranspile()],
  oxc: false,
  resolve: { alias: MYCO_ALIASES },
  test: { environment: "node", include: ["spikes/plugin-export-step/**/*.test.ts"] },
});
