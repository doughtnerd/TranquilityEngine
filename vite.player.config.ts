// PLAYER bundle (ADR 0041): player.html + src/player/ as a project-independent page in
// dist/player/, which game exports copy (as index.html) beside the project's files. The engine is
// a second entry with a fixed name, myco.js, whose exports are kept, so the compiled project
// scripts of a build import the same engine module as the player. files.json lists the output for
// the exporters (`npm run export`, and the editor, which serves a copy at player/).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { playerFileList, typescriptTranspile } from "./vite.shared.ts";

export default defineConfig({
  plugins: [typescriptTranspile(), playerFileList()],
  oxc: false,
  base: "./", // a build runs from any folder of any host
  build: {
    outDir: "dist/player",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 5 * 1024, // the engine chunk: three.js, and Rapier with its WebAssembly inlined
    rollupOptions: {
      input: {
        player: fileURLToPath(new URL("./player.html", import.meta.url)),
        myco: fileURLToPath(new URL("./src/myco.ts", import.meta.url)), // the public module (ADR 0135)
      },
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) => (chunk.name === "myco" ? "myco.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
