// DF: runs the core wall-clock benches (`src/plugins/audio/runtime/core/*.bench.ts`: selectionBench, hrtfCost) as a plain Vitest
// file, apart from `npm test` (whose include is `*.test.ts`). Same shape as `capture.vitest.config.mts`.
//
//   npx vitest run --config tools/audio-bench/selection.vitest.config.mts
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "../../vite.shared.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root,
  cacheDir: join(tmpdir(), "myco-selection-bench-vite"),
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  test: {
    environment: "node",
    include: ["src/plugins/audio/runtime/core/*.bench.ts"],
    setupFiles: ["./src/plugins/testSetup.ts"],
    testTimeout: 600_000,
    fileParallelism: false,
    pool: "forks",
  },
});
