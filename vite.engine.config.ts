// ENGINE library bundle (ADR 0015): src/engine/index.ts as one ES module in dist/engine/.
// three.js, Rapier and Howler stay external; the consuming game bundles them. Type
// declarations come from `tsc -p tsconfig.engine.json` (see the build:engine script).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile()],
  oxc: false,
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/engine/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: "engine",
    },
    outDir: "dist/engine",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [/^three(\/.*)?$/, "howler", /^@dimforge\//],
    },
  },
});
