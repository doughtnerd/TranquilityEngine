// So1 (ADR 0171 amended by 0172, M5d): the capture soaks (`src/plugins/audio/**/*.soak.ts`) as plain Vitest files, apart from
// `npm test` (whose include is `*.test.ts`) and from Bn2's capture benches. Each soak runs minutes of audio on the loopback
// host's clock (accelerated, not wall time) and prints a table with `console.log`; the cases assert the audio clock, sizes,
// structure and accuracy, never a wall-clock time (ground rules). Run one at a time, alone on the machine:
//
//   npx vitest run --config tools/audio-bench/soak.vitest.config.mts <file filter>
//
// The soaks that read the Profiler's model (`editor/mix/*.soak.ts`) live in the editor half, since a runtime file never
// imports it (ADR 0133); the rest live beside the recorder (`runtime/capture/*.soak.ts`).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "../../vite.shared.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  root,
  // Its own cache: node_modules is shared between worktrees, and a sibling Vitest run clears its cache directory.
  cacheDir: join(tmpdir(), "myco-capture-soak-vite"),
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  test: {
    environment: "node",
    include: ["src/plugins/audio/**/*.soak.ts"],
    setupFiles: ["./src/plugins/testSetup.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
    // One file at a time, one fork: a soak must not share the machine with a sibling.
    fileParallelism: false,
    pool: "forks",
  },
});
