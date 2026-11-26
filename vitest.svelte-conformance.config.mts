import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { defaultServerConditions, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { MYCO_ALIASES, typescriptTranspile } from "./vite.shared.ts";

// The Svelte conformance harness (ADR 0419): Svelte 5.59.2's runtime-runes fixtures run against the engine's
// renderer. `npm run test:svelte-conformance` (which fetches the fixtures first); never part of `npm test`.

const root = dirname(fileURLToPath(import.meta.url));
// Its real path: the runtime the engine imports resolves through symlinks (a worktree's linked node_modules), and a
// fixture importing Svelte's sources by relative path must get those same module instances.
const svelteSrc = realpathSync(join(root, "node_modules/svelte/src"));
const PAGE_GLOBALS = join(root, "tools/svelte-conformance/pageGlobals.ts");

/** The fixtures import Svelte's harness (`../../test`) and Svelte's sources by relative path: point them at the shim and the installed package. */
function fixtureImports(): Plugin {
  return {
    name: "myco:svelte-conformance-imports",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !importer.includes("svelte-conformance")) return null;
      if (source === "../../test" || source === "../../test.ts") return join(root, "tools/svelte-conformance/testShim.ts");
      // Svelte's animation helper patches jsdom's `HTMLElement.prototype.animate`; the fixtures only take its `raf`.
      if (/^\.\.\/\.\.\/\.\.\/animation-helpers(\.js)?$/.test(source)) return PAGE_GLOBALS;
      // `svelte/reactivity` is the engine's, as a game's components get it (its `MediaQuery` follows the canvas).
      if (source === "svelte/reactivity") return join(root, "src/plugins/ui/svelte/reactivity.ts");
      // Svelte's harness compiles into `_output/client/`, which a config can import (HMR); ours is `_output_myco/`.
      if (source.startsWith("./_output/client/")) return resolve(dirname(importer.split("?")[0]), source.replace("./_output/client/", "./_output_myco/"));
      // Bare imports resolve as the engine's own (one Svelte instance, with the custom-renderer condition).
      if (source === "svelte" || source.startsWith("svelte/") || source === "vitest" || source === "tinyglobby") return this.resolve(source, join(root, "src/myco.ts"), { ...options, skipSelf: true });
      if (!source.startsWith(".")) return null;
      const abs = resolve(dirname(importer.split("?")[0]), source);
      const at = abs.indexOf("/packages/svelte/src/");
      if (at >= 0) {
        let path = join(svelteSrc, abs.slice(at + "/packages/svelte/src/".length));
        if (!/\.[cm]?js$/.test(path)) path += ".js";
        return path;
      }
      // Compiled output imports siblings by their source name (`./Child.svelte`): the compiled file is beside it with `.js`.
      if (importer.includes("/_output_myco/") && abs.endsWith(".svelte")) return `${abs}.js`;
      return null;
    },
    // Svelte's test helpers in TypeScript (`suite.ts`) sit under node_modules/.cache, which the engine's tsc plugin skips.
    transform(code, id) {
      if (!id.includes("svelte-conformance")) return null;
      // A config naming the page's `window` or `document` (jsdom globals in Svelte's harness) gets the harness's (pageGlobals.ts).
      if (/[\\/]_config\.js$/.test(id.split("?")[0])) {
        const names = ["window", "document"].filter((n) => new RegExp(`(?<![.\\w$])${n}\\b`).test(code));
        return names.length ? `import { ${names.join(", ")} } from ${JSON.stringify(PAGE_GLOBALS)};\n${code}` : null;
      }
      if (!id.endsWith(".ts")) return null;
      return ts.transpileModule(code, { fileName: id, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    },
  };
}

export default defineConfig({
  plugins: [fixtureImports(), typescriptTranspile()],
  oxc: false,
  resolve: { alias: MYCO_ALIASES },
  ssr: { resolve: { conditions: ["svelte-custom-renderer", ...defaultServerConditions], externalConditions: ["svelte-custom-renderer"] } },
  test: {
    environment: "node",
    include: ["tools/svelte-conformance/**/*.test.ts"],
    setupFiles: ["./src/plugins/testSetup.ts"],
    server: { deps: { inline: [/[\\/]svelte[\\/]/] } },
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
