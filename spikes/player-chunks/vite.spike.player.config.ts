// Spike-only: the real player config plus a module report. outDir is redirected so dist/player stays untouched.
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "../../vite.player.config.ts";
import { chunkReport } from "./report-plugin.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default mergeConfig(base as never, {
  plugins: [chunkReport(here("./out/player-report.json"))],
  build: { outDir: here("./out/player"), emptyOutDir: true },
});
