// ENGINE library bundle (ADR 0015): src/engine/index.ts as one ES module in dist/engine/.
// three.js, Babylon.js, Rapier and Howler stay external; the consuming game bundles them. Type
// declarations come from `tsc -p tsconfig.engine.json` (see the build:engine script).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { typescriptTranspile } from "./vite.shared.ts";

const NAV_WASM = "myco_nav_bg.wasm";

/**
 * Library mode always inlines `new URL(…, import.meta.url)` assets as data URLs, which would put the 1.8 MB navigation
 * WASM (ADR 0065) into the bundle as base64. Instead it ships as `dist/engine/myco_nav_bg.wasm` beside the chunks, and
 * the loader's URL points there with a specifier Vite leaves alone (the consuming game's bundler copies it).
 */
function navWasmBesideBundle(): Plugin {
  const literal = `new URL("./wasm/${NAV_WASM}", import.meta.url)`;
  return {
    name: "myco-nav-wasm-beside-bundle",
    enforce: "pre",
    transform(code, id) {
      if (!id.replaceAll("\\", "/").endsWith("src/engine/nav/loader.ts") || !code.includes(literal)) return null;
      // Same line, so the mapping is unchanged (map: null keeps the previous one).
      return { code: code.replace(literal, `new URL(/* @vite-ignore */ ${JSON.stringify("./" + NAV_WASM)}.toString(), import.meta.url)`), map: null };
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: NAV_WASM, source: readFileSync(new URL(`./src/engine/nav/wasm/${NAV_WASM}`, import.meta.url)) });
    },
  };
}

export default defineConfig({
  plugins: [navWasmBesideBundle(), typescriptTranspile()],
  oxc: false,
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/engine/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: "engine",
    },
    outDir: "dist/engine",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [/^three(\/.*)?$/, /^@babylonjs\//, "howler", /^@dimforge\//, /^@tauri-apps\//],
    },
  },
});
