// EDITOR bundle (ADR 0022): editor.html + src/editor/ as a complete app in dist/editor/, the
// folder the editor's Tauri shell loads. In dev, the main server serves it at /editor.html.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile()],
  oxc: false,
  build: {
    outDir: "dist/editor",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 5 * 1024,
    rollupOptions: {
      input: fileURLToPath(new URL("./editor.html", import.meta.url)),
    },
  },
});
