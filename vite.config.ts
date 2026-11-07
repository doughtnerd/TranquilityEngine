// Dev server (ADR 0015): `npm run dev` serves the editor at /editor.html (/ redirects there) with
// the engine imported from src/, and the sample projects at /samples/ (ADR 0031). The editor
// bundle and the engine library have their own configs: vite.editor.config.ts and
// vite.engine.config.ts. Games build from the prebuilt player (vite.player.config.ts, ADR 0041), served
// here at /player/ once built, for the editor's Export.
import { defineConfig } from "vite";
import { engineTypes, playerFiles, samples, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes(), samples(), playerFiles()],
  // Monaco's language workers (the editor's Code panel, ADR 0030) and the navigation bake worker (ADR 0065)
  // are ES modules; worker bundles get their own plugins, so TypeScript is transpiled there too.
  worker: { format: "es", plugins: () => [typescriptTranspile()] },
  oxc: false,
  // Tauri (src-tauri/) expects a fixed dev port, its own output left on screen, and Rust sources unwatched.
  clearScreen: false,
  server: {
    port: 3000,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    // Start-up (ADR 0082): transform the Projects window's and the editor's entries as the server
    // starts, before a window asks for them. Projects first: it is the window shown first.
    warmup: { clientFiles: ["./src/editor/launcher/main.tsx", "./src/editor/main.tsx"] },
  },
  optimizeDeps: {
    // The dependency scanner compiles JSX itself and never sees the `preact/jsx-runtime` import that
    // tsc (typescriptTranspile) adds, so on a cold cache it was found late, re-bundled, and every open
    // page reloaded: both desktop windows started over (ADR 0082).
    include: ["preact/jsx-runtime"],
  },
});
