// Bn2: runs the capture benches (`src/plugins/audio/runtime/capture/*.bench.ts`) as plain Vitest files, apart from
// `npm test` (whose include is `*.test.ts`) and from `vitest bench` (whose include is `bench/**`). Each bench file
// prints its numbers with `console.log`; none asserts a wall-clock time (ground rules).
//
//   npx vitest run --config tools/audio-bench/capture.vitest.config.mts [file filter]
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "../../vite.shared.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root,
  // Its own cache: node_modules is shared between worktrees, and a sibling Vitest run clears its cache directory.
  cacheDir: join(tmpdir(), "myco-capture-bench-vite"),
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  test: {
    environment: "node",
    include: ["src/plugins/audio/runtime/capture/*.bench.ts"],
    setupFiles: ["./src/plugins/testSetup.ts"],
    testTimeout: 600_000,
    // One file at a time, one fork: a timing figure must not share the machine with a sibling bench.
    fileParallelism: false,
    pool: "forks",
  },
});
