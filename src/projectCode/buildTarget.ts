// The build target of the project code linker (ADR 0329): each module becomes a file of a game build
// (ADR 0041), written later by the build writer (ADR 0296). A script goes to `code/<path>.js`, a JSON
// file it imports to a module exporting its contents beside it, the bundled npm packages to
// `code/deps/` (ADR 0125); imports point at those files by relative path, and `"myco"` at the engine
// module beside the player. Scripts compile without source maps, so a build doesn't ship the TypeScript.
//
// UI modules (ADR 0423: Svelte components, rune modules, the `.css` modules components import) are
// bundled with the Svelte runtime and renderer they use into the game's own code when the link closes
// (ADR 0425, `uiBundle.ts`), each still at its own `code/` address.
import { ENGINE_FILE, modulePath, relativeSpecifier } from "../export/format";
import { rewriteImports } from "../editor/moduleImports";
import { EDITOR_MODULE, isEngineModule } from "./compile";
import type { LinkTarget, TargetLink } from "./linker";
import { BUILD_FILE, bundleUI, type UIRuntimeSource } from "./uiBundle";
import { isUISourcePath } from "./uiModules";

/** Where the bundled npm packages go in a build (ADR 0125): `code/deps/<chunk>.js`. */
export const DEPS_DIR = "code/deps";

/** A module the UI bundle takes: a Svelte source, or a `.css` file a component imports. */
const isUIModule = (path: string) => isUISourcePath(path) || path.endsWith(".css");

/**
 * Links code into build files (ADR 0329): the output is every file by build path. `ui` is where a game's UI
 * runtime comes from (ADR 0425); without it, UI code can't be built (each module is a problem).
 */
export function buildTarget(options: { readonly ui?: UIRuntimeSource } = {}): LinkTarget<ReadonlyMap<string, string>> {
  const ui = options.ui;
  // Without a runtime, nothing is bundled: UI modules that import it are problems (`uiRuntime`), the rest are plain files.
  const bundled = (path: string) => ui !== undefined && isUIModule(path);
  return {
    sourceMap: false,
    dev: false,

    open(): TargetLink<ReadonlyMap<string, string>> {
      const files = new Map<string, string>();
      const uiModules = new Map<string, string>();
      return {
        packages: async (_key, bundle) => {
          const made = await bundle();
          for (const [name, chunk] of made.chunks) {
            const out = `${DEPS_DIR}/${name}`;
            files.set(out, rewriteImports(chunk.code, chunk.imports, (spec) => (isEngineModule(spec) ? relativeSpecifier(out, ENGINE_FILE) : spec)));
          }
          return { bundle: made, entries: new Map([...made.entries].map(([spec, entry]) => [spec, `${DEPS_DIR}/${entry}`])) };
        },
        uiRuntime: async () => {
          if (!ui) throw new Error("this build has no Svelte runtime to bundle it with");
        },
        json: (path, value) => {
          files.set(modulePath(path), `export default ${JSON.stringify(value)};\n`);
          return modulePath(path);
        },
        // The editor SDK never ships (only editor halves import it, and builds select none): left as written.
        // In UI modules, other build files are `myco-build:` paths and runtime modules stay bare, for the UI bundle.
        specifier: (from, to) => {
          if ("editorSdk" in to) return EDITOR_MODULE;
          const file = "engine" in to ? ENGINE_FILE : "address" in to ? to.address : null;
          if (file === null) return (to as { ui: string }).ui; // only linked once `uiRuntime` has passed, so `bundled(from)`
          return bundled(from) ? BUILD_FILE + file : relativeSpecifier(modulePath(from), file);
        },
        script: async (path, code) => {
          (bundled(path) ? uiModules : files).set(modulePath(path), code);
          return modulePath(path);
        },
        close: async () => {
          if (ui && uiModules.size > 0) for (const [path, code] of await bundleUI(uiModules, ui)) files.set(path, code);
          return files;
        },
      };
    },
  };
}
