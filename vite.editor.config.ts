// EDITOR bundle (ADR 0022): editor.html + src/editor/ as a complete app in dist/editor/, the
// folder the editor's Tauri shell loads, with the sample projects copied beside it in
// dist/editor/samples/ (ADR 0031) and the prebuilt game player in dist/editor/player/ (ADR 0041,
// built first by `npm run build:editor`). The Audio Studio (studio.html, ADR 0341) is a second entry of the
// same build. In dev, the main server serves them at /editor.html and /studio.html.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { engineTypes, playerFiles, rendezvousFile, samples, typescriptTranspile, uiRuntimeFiles } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes(), samples(), playerFiles(), rendezvousFile(), uiRuntimeFiles()],
  // Monaco's language workers (the editor's Code panel, ADR 0030) and the navigation bake worker (ADR 0065)
  // are ES modules; worker bundles get their own plugins, so TypeScript is transpiled there too.
  worker: { format: "es", plugins: () => [typescriptTranspile()] },
  oxc: false,
  build: {
    outDir: "dist/editor",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 5 * 1024,
    rollupOptions: {
      // projects.html: the desktop editor's Projects window (ADR 0059). panel-window.html: the empty page a
      // detached panel window opens, which the editor renders into (ADR 0174, src/editor/windows/childWindow.ts).
      // studio.html: the Audio Studio, a second app on the editor's frontend (ADR 0341, src/studio/).
      input: [
        fileURLToPath(new URL("./editor.html", import.meta.url)),
        fileURLToPath(new URL("./projects.html", import.meta.url)),
        fileURLToPath(new URL("./panel-window.html", import.meta.url)),
        fileURLToPath(new URL("./studio.html", import.meta.url)),
      ],
    },
  },
});
