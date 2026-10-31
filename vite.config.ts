// Dev server and GAME build (ADR 0015). `npm run dev` serves index.html with the engine imported
// from src/; `npm run build:game` bundles the Flappy demo (engine, three.js, Rapier, Howler and
// assets included) into dist/game/, the folder a Tauri shell loads. The engine library bundle
// has its own config: vite.engine.config.ts.
import { defineConfig } from "vite";
import { typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile()],
  oxc: false,
  // Tauri (src-tauri/) expects a fixed dev port, its own output left on screen, and Rust sources unwatched.
  clearScreen: false,
  server: { port: 3000, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  preview: { port: 4173, strictPort: true },
  build: {
    outDir: "dist/game",
    emptyOutDir: true,
    sourcemap: true,
    // The main chunk is ~4 MiB because @dimforge/rapier2d-compat embeds its WASM as base64
    // (plus three.js). Fine for Tauri; loading the non-compat WASM separately would shrink it.
    chunkSizeWarningLimit: 5 * 1024,
  },
});
