// A game's UI code bundle (ADR 0425): at export, the project's compiled Svelte UI modules (components, rune
// modules and the `.css` modules components import) are bundled with the parts of Svelte's runtime and the
// engine's renderer they use, tree-shaken, into the game's own code. One build of every UI module, each an
// entry at its own address, with code splitting: the game gets one Svelte instance, and scripts that import
// a UI module import the same one. The player carries no Svelte.
//
// The runtime comes from the engine's files (`UIRuntimeSource`): Svelte's client runtime under
// `node_modules/` and the renderer under `src/`, resolved like npm packages (packageResolver.ts) and
// bundled with esbuild, in Node (`npm run export`, from the engine's checkout) and in the editor's page
// (the editor serves the same files, `collectUIRuntimeFiles`), so both make the same code. What the renderer
// imports from the engine's own modules stays in the player: an import of its `myco-ui-host.js` entry.
import type * as Esbuild from "esbuild-wasm";
import { importSites, rewriteImports, typescript } from "../editor/moduleImports";
import type { EsbuildApi } from "../editor/packages";
import { PackageResolver, dirname, join, type PackageFiles } from "../editor/packageResolver";
import { relativeSpecifier } from "../export/format";
import { compilerOptions, SCRIPT_EMIT } from "../scriptCompiler.mjs";
import { BUILTIN_UI_COMPONENTS } from "./builtinUI";
import { ENGINE_SOURCE_DIR, UI_HOST_FILE, UI_HTML_SOURCE, UI_REACTIVITY_SOURCE, UI_RENDERER_SOURCE, UI_RUNTIME_SPECIFIERS } from "./uiModules";

/** Where a game's UI runtime comes from: the engine's files, and esbuild to bundle them with. */
export interface UIRuntimeSource {
  /** The engine's files by path from its root ("/"-separated): `node_modules/svelte/…`, `src/plugins/ui/svelte/renderer.ts`. */
  readonly files: PackageFiles;
  /** esbuild, initialised (loaded on first use). */
  readonly esbuild: () => Promise<EsbuildApi>;
}

/**
 * The prefix of a build file a UI module imports (`myco-build:code/scripts/a.js`, `myco-build:myco.js`): the
 * linker's build target writes every address this way in UI modules, and the bundle writes each back as a
 * relative path from the file the import lands in.
 */
export const BUILD_FILE = "myco-build:";

/** The export conditions the runtime resolves with: the production builds of packages (`esm-env`'s DEV is false). */
const CONDITIONS = ["production"];

/** Where the bundle's shared chunks go, by build path. */
const CHUNKS = "code/ui-runtime/[name]-[hash]";

/** What one import from a runtime file resolves to: a runtime file, an empty module, the player's host entry, or why not. */
type RuntimeImport = { file: string } | { empty: true } | { host: true } | { error: string };

/** A TypeScript file at `base` (the renderer's own imports), as written or with `.ts` or `/index.ts`. */
async function probeTs(resolver: PackageResolver, base: string): Promise<string | null> {
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) if ((await resolver.read(candidate)) !== null) return candidate;
  return null;
}

/**
 * Resolve `specifier` imported from runtime file `importer` ("" for a UI module): `myco/ui-renderer` is the
 * renderer; the renderer's relative imports into the engine's own modules are the host entry, its other relative
 * imports TypeScript beside it; everything else resolves like an npm package (Svelte's `exports` and `imports` maps).
 */
async function resolveRuntimeImport(resolver: PackageResolver, specifier: string, importer: string): Promise<RuntimeImport> {
  if (specifier === "myco/ui-renderer") return { file: UI_RENDERER_SOURCE };
  if (specifier === "myco/ui-html") return { file: UI_HTML_SOURCE }; // ADR 0429
  // UI code's `svelte/reactivity` is Svelte's with `MediaQuery` on the canvas (ADR 0422 wave 5); that module imports Svelte's.
  // Svelte's `svelte/motion` gets it too, so its `prefersReducedMotion` follows the engine's setting (ADR 0423 wave Z3).
  if (specifier === "svelte/reactivity" && (importer === "" || importer.endsWith("svelte/src/motion/index.js"))) return { file: UI_REACTIVITY_SOURCE };
  if (importer.endsWith(".ts") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const base = join(dirname(importer), specifier);
    if (base.startsWith(ENGINE_SOURCE_DIR)) return { host: true };
    const file = await probeTs(resolver, base);
    return file ? { file } : { error: `can't find "${specifier}" from ${importer}` };
  }
  return resolver.resolve(specifier, importer);
}

/** `esm-env`'s flags, which Svelte's runtime reads, as a game build has them: production, in a browser. */
const ESM_ENV: Readonly<Record<string, string>> = { BROWSER: "true", DEV: "false", NODE: "false" };
const ESM_ENV_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*["']esm-env["'];?/gm;

/**
 * `esm-env` imports left out (`import { DEV } from 'esm-env'`), so the flags are free names in the importing file,
 * which the bundle's `define` replaces with their values as it parses: Svelte's dev-only branches then fold away in
 * every file. Imported, esbuild keeps the flag a variable in some files (Svelte's `errors.js`), with its dev
 * messages. An import of a name it doesn't know, or renamed, is left as written.
 */
function inlineEsmEnv(code: string): string {
  return code.replace(ESM_ENV_IMPORT, (all, names: string) => {
    const bindings = names.split(",").map((n) => n.trim()).filter(Boolean);
    return bindings.every((name) => name in ESM_ENV) ? `/* esm-env: ${bindings.join(", ")} */` : all;
  });
}

/**
 * A runtime file's code as esbuild loads it: TypeScript (the renderer) transpiled with the engine's emit settings,
 * `esm-env` flags inlined.
 */
async function runtimeCode(resolver: PackageResolver, path: string): Promise<string | null> {
  const raw = await resolver.read(path);
  const text = raw === null ? null : inlineEsmEnv(raw);
  if (text === null || !path.endsWith(".ts")) return text;
  const ts = await typescript();
  return ts.transpileModule(text, { fileName: path, compilerOptions: compilerOptions(SCRIPT_EMIT) }).outputText;
}

/** esbuild's plugin: UI modules from `modules`, runtime files from the engine's files, build files external. */
function uiPlugin(resolver: PackageResolver, modules: ReadonlyMap<string, string>): Esbuild.Plugin {
  return {
    name: "myco-ui-bundle",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.path.startsWith(BUILD_FILE)) {
          const path = args.path.slice(BUILD_FILE.length);
          return modules.has(path) ? { path, namespace: "ui" } : { path: args.path, external: true };
        }
        const importer = args.namespace === "runtime" ? args.importer : "";
        const result = await resolveRuntimeImport(resolver, args.path, importer);
        if ("host" in result) return { path: BUILD_FILE + UI_HOST_FILE, external: true };
        if ("file" in result) return { path: result.file, namespace: "runtime" };
        if ("empty" in result) return { path: args.path, namespace: "empty" };
        return { errors: [{ text: result.error }] };
      });
      build.onLoad({ filter: /.*/, namespace: "ui" }, (args) => ({ contents: modules.get(args.path)!, loader: "js" }));
      build.onLoad({ filter: /.*/, namespace: "runtime" }, async (args) => {
        const contents = await runtimeCode(resolver, args.path);
        if (contents === null) return { errors: [{ text: `can't read ${args.path}` }] };
        return { contents, loader: args.path.endsWith(".json") ? "json" : "js" };
      });
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "module.exports = {};", loader: "js" }));
    },
  };
}

/**
 * Bundle a game's UI modules (`modules`: code by build address, `code/ui/Hud.svelte.js`) with the runtime they
 * use, tree-shaken and minified: every file of the bundle by build path. Each module is an entry at its own
 * address; shared code is in chunks under `code/ui-runtime/`. In `modules`' code, imports of other build files
 * are written `myco-build:<path>` and runtime modules by their specifiers (`svelte/internal/client`,
 * `myco/ui-renderer`); in the output, every import is a relative path. Throws esbuild's failure.
 */
export async function bundleUI(modules: ReadonlyMap<string, string>, source: UIRuntimeSource): Promise<Map<string, string>> {
  const resolver = new PackageResolver(source.files, CONDITIONS);
  const esbuild = await source.esbuild();
  const result = await esbuild.build({
    entryPoints: [...modules.keys()].sort().map((path) => ({ in: BUILD_FILE + path, out: path.replace(/\.js$/, "") })),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: "/",
    chunkNames: CHUNKS,
    write: false,
    logLevel: "silent",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), global: "globalThis", ...ESM_ENV },
    plugins: [uiPlugin(resolver, modules)],
  });
  const ts = await typescript();
  const files = new Map<string, string>();
  for (const file of result.outputFiles ?? []) {
    const path = file.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const code = file.text;
    files.set(path, rewriteImports(code, importSites(ts, code), (spec) => (spec.startsWith(BUILD_FILE) ? relativeSpecifier(path, spec.slice(BUILD_FILE.length)) : spec)));
  }
  return files;
}

/**
 * The engine's files a game's UI bundle can read (ADR 0425), by path from the engine's root: every runtime module
 * compiled UI code may import, the files they import in turn, the renderer and its own imports, and the
 * `package.json` files resolving them reads, and the built-in UI components' sources. The editor serves these (it can't read the engine's folder), so its
 * exports bundle exactly what `npm run export` does from the folder itself.
 */
export async function collectUIRuntimeFiles(files: PackageFiles): Promise<Map<string, string>> {
  const read = new Map<string, string>();
  const resolver = new PackageResolver({
    read: async (path) => {
      const text = await files.read(path);
      if (text !== null) read.set(path, text);
      return text;
    },
  }, CONDITIONS);
  const ts = await typescript();
  const seen = new Set<string>();
  const queue: { specifier: string; importer: string }[] = UI_RUNTIME_SPECIFIERS.map((specifier) => ({ specifier, importer: "" }));
  while (queue.length > 0) {
    const { specifier, importer } = queue.shift()!;
    // An import that doesn't resolve is left for the bundle to report, if any code really imports it.
    const result = await resolveRuntimeImport(resolver, specifier, importer);
    if (!("file" in result) || seen.has(result.file)) continue;
    seen.add(result.file);
    const code = await runtimeCode(resolver, result.file);
    if (code === null || result.file.endsWith(".json") || result.file.endsWith(".d.ts")) continue;
    for (const imp of importSites(ts, code)) queue.push({ specifier: imp.specifier, importer: result.file });
  }
  // The engine's built-in UI components' sources (ADR 0423 wave B), which a build compiles when the project uses them.
  for (const c of BUILTIN_UI_COMPONENTS) await files.read(c.source).then((text) => text !== null && read.set(c.source, text));
  return read;
}
