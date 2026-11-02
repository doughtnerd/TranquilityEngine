// Dev server (ADR 0015): `npm run dev` serves the editor at /editor.html (/ redirects there) with
// the engine imported from src/, and the sample projects at /samples/ (ADR 0031). The editor
// bundle and the engine library have their own configs: vite.editor.config.ts and
// vite.engine.config.ts. There's no standalone game build until project game builds are designed.
import { defineConfig } from "vite";
import { engineTypes, samples, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), engineTypes(), samples()],
  // Monaco's language workers (the editor's Code panel, ADR 0030) are ES modules.
  worker: { format: "es" },
  oxc: false,
  // Tauri (src-tauri/) expects a fixed dev port, its own output left on screen, and Rust sources unwatched.
  clearScreen: false,
  server: { port: 3000, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
