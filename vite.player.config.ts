// PLAYER bundle (ADR 0041): player.html + src/player/ as a project-independent page in
// dist/player/, which game exports copy (as index.html) beside the project's files. The engine is
// a second entry with a fixed name, myco.js, whose exports are kept, so the compiled project
// scripts of a build import the same engine module as the player. files.json lists the output for
// the exporters (`npm run export`, and the editor, which serves a copy at player/).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { CAPTURE_CODEC, DEBUG_LINK, lazyOnly, playerFileList, typescriptTranspile, uiHostEntry } from "./vite.shared.ts";

// ADR 0421: the player carries no Svelte. A game's UI bundle (Svelte and the renderer) imports the engine pieces the
// renderer uses from this fixed-name entry, myco-ui-host.js, sharing the engine instance with myco.js.
const uiHost = uiHostEntry();

export default defineConfig({
  plugins: [
    typescriptTranspile(),
    uiHost.plugin,

    playerFileList({ debug: DEBUG_LINK }), // files.json's `debug`: the debug link's chunks, which release exports leave out (ADR 0376)
    lazyOnly([CAPTURE_CODEC]), // a game that never records loads none of the capture codec
  ],
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
        ...uiHost.input,
      },
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) => (chunk.name === "myco" ? "myco.js" : chunk.name in uiHost.input ? uiHost.fileName : "assets/[name]-[hash].js"),

      },
    },
  },
});
