import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { engineTypes, typescriptTranspile } from "../../../vite.shared.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Same transpile as the engine's own config (standard decorators), but only this folder's tests.
export default defineConfig({
  root,
  plugins: [typescriptTranspile(), engineTypes()],
  oxc: false,
  resolve: { alias: { myco: fileURLToPath(new URL("../../../src/myco.ts", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["spikes/audio-spatial/occlusion/*.test.ts"],
    setupFiles: ["./src/plugins/testSetup.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
