// Bundles tools/rendezvous/main.ts and `ws` into one dependency-free ES module, dist/rendezvous/rendezvous.mjs (plan task R3).
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { typescriptTranspile } from "../../vite.shared.ts";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [typescriptTranspile()],
  oxc: false,
  logLevel: "warn",
  ssr: { noExternal: true },
  build: {
    outDir: "dist/rendezvous",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    ssr: "tools/rendezvous/main.ts",
    rollupOptions: {
      external: [...builtinModules, /^node:/],
      output: { format: "es", entryFileNames: "rendezvous.mjs", codeSplitting: false },
    },
  },
});
