// The spike's whole Svelte toolchain: a Vite plugin that compiles `*.svelte` files with the custom
// renderer (svelte 5.59.2 `experimental.customRenderer`), and `*.svelte.ts` rune modules. No
// vite-plugin-svelte: the compiler is called directly, as the engine's export/editor would.
import { compile, compileModule } from "svelte/compiler";
import ts from "typescript";
import { fileURLToPath } from "node:url";

export const RENDERER = fileURLToPath(new URL("./src/renderer.ts", import.meta.url));

/** Compiler options the spike uses everywhere. */
export function svelteOptions(filename, extra = {}) {
  return {
    filename,
    generate: "client",
    css: "external", // `injected` needs `textContent` on a <style> node, which custom renderers don't have
    dev: false,
    experimental: { customRenderer: RENDERER },
    ...extra,
  };
}

export function svelteUI({ dev = false } = {}) {
  return {
    name: "spike:svelte-ui",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (file.endsWith(".svelte")) {
        // <script lang="ts"> needs no preprocessing: Svelte 5 strips type annotations itself.
        const r = compile(code, svelteOptions(file, { dev }));
        for (const w of r.warnings) this.warn(`${w.code}: ${w.message}`);
        return { code: r.js.code, map: r.js.map };
      }
      if (file.endsWith(".svelte.ts")) {
        const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        const r = compileModule(js, { filename: file, generate: "client", dev });
        return { code: r.js.code, map: r.js.map };
      }
      return null;
    },
  };
}
