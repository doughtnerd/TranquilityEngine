// ENGINE library bundle (ADR 0015): the public module, src/myco.ts (ADR 0135), as one ES module in dist/engine/.
// three.js, Babylon.js and Rapier stay external; the consuming game bundles them. Type
// declarations come from `tsc -p tsconfig.engine.json` (see the build:engine script).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { typescriptTranspile } from "./vite.shared.ts";

/** Files the engine loads by `new URL(…, import.meta.url)`: the module that does, and the file's path beside it. */
const BESIDE_BUNDLE = [
  { module: "src/engine/nav/loader.ts", path: "./wasm/myco_nav_bg.wasm" }, // ADR 0065
  { module: "src/engine/ui/fonts.ts", path: "./fonts/Inter-latin-wght.woff2" }, // ADR 0076
  { module: "src/plugins/audio/runtime/core/loader.ts", path: "../wasm/myco_audio.wasm" }, // ADR 0157
  { module: "src/plugins/audio/runtime/core/hrir.ts", path: "../wasm/myco_hrir.bin" }, // ADR 0157
  { module: "src/plugins/audio/runtime/core/hrir.ts", path: "../../../../engine/audio/magls-o3.bin" }, // ADR 0162 (A3)
  { module: "src/plugins/audio/runtime/decoder/decoderClient.ts", path: "../wasm/myco_audio_decode.wasm" }, // ADR 0157 (B2)
  { module: "src/plugins/audio/runtime/decoder/decoderClient.ts", path: "../wasm/myco_audio_decode_aac.wasm" }, // ADR 0157 (B4)
];

/**
 * Library mode always inlines `new URL(…, import.meta.url)` assets as data URLs, which would put the 1.8 MB navigation
 * WASM (ADR 0065) into the bundle as base64 (and the bundled UI font, ADR 0076). Instead each ships beside the chunks
 * (`dist/engine/myco_nav_bg.wasm`, `dist/engine/Inter-latin-wght.woff2`), and the loader's URL points there with a
 * specifier Vite leaves alone (the consuming game's bundler copies it).
 */
function assetsBesideBundle(): Plugin {
  const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  return {
    name: "myco-assets-beside-bundle",
    enforce: "pre",
    transform(code, id) {
      const file = id.replaceAll("\\", "/");
      // A module may load more than one file (the decoder client: the default and the AAC decoder).
      let out = code;
      for (const entry of BESIDE_BUNDLE.filter((e) => file.endsWith(e.module))) {
        const literal = `new URL(${JSON.stringify(entry.path)}, import.meta.url)`;
        // Same line, so the mapping is unchanged (map: null keeps the previous one).
        out = out.replace(literal, `new URL(/* @vite-ignore */ ${JSON.stringify("./" + fileName(entry.path))}.toString(), import.meta.url)`);
      }
      return out === code ? null : { code: out, map: null };
    },
    generateBundle() {
      for (const e of BESIDE_BUNDLE) {
        const dir = e.module.slice(0, e.module.lastIndexOf("/") + 1);
        this.emitFile({ type: "asset", fileName: fileName(e.path), source: readFileSync(new URL(e.path, new URL(`./${dir}`, import.meta.url))) });
      }
    },
  };
}

export default defineConfig({
  plugins: [assetsBesideBundle(), typescriptTranspile()],
  oxc: false,
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/myco.ts", import.meta.url)),
      formats: ["es"],
      fileName: "engine",
    },
    outDir: "dist/engine",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [/^three(\/.*)?$/, /^@babylonjs\//, /^@dimforge\//, /^@tauri-apps\//],
    },
  },
});
