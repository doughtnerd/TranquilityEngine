// The build target of the project code linker (ADR 0329): each module becomes a file of a game build
// (ADR 0041), written later by the build writer (ADR 0296). A script goes to `code/<path>.js`, a JSON
// file it imports to a module exporting its contents beside it, the bundled npm packages to
// `code/deps/` (ADR 0125); imports point at those files by relative path, and `"myco"` at the engine
// module beside the player. Scripts compile without source maps, so a build doesn't ship the TypeScript.
import { ENGINE_FILE, modulePath, relativeSpecifier } from "../export/format";
import { rewriteImports } from "../editor/moduleImports";
import { EDITOR_MODULE, isEngineModule } from "./compile";
import type { LinkTarget, TargetLink } from "./linker";
import { uiRuntimeFile } from "./uiModules";


/** Where the bundled npm packages go in a build (ADR 0125): `code/deps/<chunk>.js`. */
export const DEPS_DIR = "code/deps";

/** Links code into build files (ADR 0329): the output is every file by build path. */
export const buildTarget: LinkTarget<ReadonlyMap<string, string>> = {
  sourceMap: false,
  dev: false,

  open(): TargetLink<ReadonlyMap<string, string>> {
    const files = new Map<string, string>();
    return {
      packages: async (_key, bundle) => {
        const made = await bundle();
        for (const [name, chunk] of made.chunks) {
          const out = `${DEPS_DIR}/${name}`;
          files.set(out, rewriteImports(chunk.code, chunk.imports, (spec) => (isEngineModule(spec) ? relativeSpecifier(out, ENGINE_FILE) : spec)));
        }
        return { bundle: made, entries: new Map([...made.entries].map(([spec, entry]) => [spec, `${DEPS_DIR}/${entry}`])) };
      },
      json: (path, value) => {
        files.set(modulePath(path), `export default ${JSON.stringify(value)};\n`);
        return modulePath(path);
      },
      // The editor SDK never ships (only editor halves import it, and builds select none): left as written.
      // UI runtime modules (ADR 0419) are entries of the prebuilt player beside myco.js, sharing its engine.
      specifier: (from, to) =>
        "engine" in to ? relativeSpecifier(modulePath(from), ENGINE_FILE) : "editorSdk" in to ? EDITOR_MODULE : "ui" in to ? relativeSpecifier(modulePath(from), uiRuntimeFile(to.ui)) : relativeSpecifier(modulePath(from), to.address),

      script: async (path, code) => {
        files.set(modulePath(path), code);
        return modulePath(path);
      },
      close: () => files,
    };
  },
};
