#!/usr/bin/env node
// `npm run bench:audio-spatial` (ADR 0162 D6): the main-thread occlusion bench. Runs D2a's occlusion pass at 64 / 256 /
// 1,024 sources with a fixed simulated 3.7 µs ray at the three presets' budgets (0.06 / 0.25 / 0.5 ms), 5 runs of
// 3,000 frames each, and prints ray ages and ms per frame (about 1 minute). The native and wasm per-quantum scenes of
// the same milestone run through `tools/audio-bench/run.mjs` and the metered gate instead.
//
//   npm run bench:audio-spatial                       # full size
//   AUDIO_BENCH_FRAMES=500 npm run bench:audio-spatial   # shorter
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "src/plugins/audio/runtime/core/occlusionBench.test.ts", "--reporter=verbose"],
  { cwd: root, stdio: "inherit", env: { ...process.env, AUDIO_BENCH: "1" } },
);
process.exit(result.status ?? 1);
