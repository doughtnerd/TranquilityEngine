// Builds the spike's harness page (bench.html + bench.ts) into .build/bench/. Same transpile rules as every
// Myco Vite config (CLAUDE.md): typescriptTranspile() from vite.shared.ts and oxc: false.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { typescriptTranspile } from "../../vite.shared.ts";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [typescriptTranspile()],
  oxc: false,
  base: "./",
  build: {
    outDir: ".build/bench",
    emptyOutDir: true,
    sourcemap: false,
    target: "esnext",
    chunkSizeWarningLimit: 8 * 1024,
    rollupOptions: { input: fileURLToPath(new URL("./bench.html", import.meta.url)) },
  },
});
