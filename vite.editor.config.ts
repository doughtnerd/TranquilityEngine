// EDITOR bundle (ADR 0022): editor.html + src/editor/ as a complete app in dist/editor/, the
// folder the editor's Tauri shell loads. In dev, the main server serves it at /editor.html.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { engineTypes, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes()],
  // Monaco's language workers (the editor's Code panel, ADR 0030) are ES modules.
  worker: { format: "es" },
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
