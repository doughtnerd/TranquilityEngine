// Project scripts (ADR 0030): the `.ts` files under a project's `scripts/` folder, compiled in the
// editor with the TypeScript compiler and loaded as ES modules. Each compiled module is loaded
// from a `data:` URL, so its imports are rewritten first: relative imports point at the other
// scripts' URLs (loaded before it), JSON files of the project become modules exporting their
// contents, and `"myco"` points at a shim module that re-exports the editor's own engine.
// Scripts and the editor then share one registry and one World.
import * as engine from "../myco"; // the public module scripts import (ADR 0135)
import { setScriptAssetRefs, unregisterScripts, withScriptRegistrations, type ScriptRegistrations } from "../engine/editor";
import { projectScriptAssetRefs } from "../engine/scene/scriptAssetRefs";
import { importSites, rewriteImports, typescript, type ImportSite } from "./moduleImports";
import { bundlePackages, chunkOrder, isPackageSpecifier, packagesKey, type PackageBundle, type PackageSource } from "./packages";
import { isScriptPath } from "./projectPaths";
import { isEditorHalfPath } from "../plugins/thirdParty";

/** The bare specifier scripts import the engine by. */
export const ENGINE_MODULE = "myco";
/** The engine's former name (ADR 0037), still accepted so existing scripts keep working. */
export const LEGACY_ENGINE_MODULE = "tranquility";
const isEngineModule = (specifier: string) => specifier === ENGINE_MODULE || specifier === LEGACY_ENGINE_MODULE;
/** The editor SDK (ADR 0133, 0139): only a plugin's editor half (`plugins/<folder>/editor/`) may import it. */
export const EDITOR_MODULE = "myco/editor";

export { isScriptPath, rewriteImports };
export type { PackageSource };

export interface ScriptProblem {
  readonly path: string;
  readonly message: string;
}

interface Compiled {
  readonly path: string;
  readonly code: string;
  readonly imports: readonly ImportSite[];
}

/**
 * Compile one script to JavaScript with the editor's own settings (`typescriptTranspile()` in
 * vite.shared.ts: ES2022, ES modules, define-semantics class fields, standard decorators), with
 * an inline source map so stack traces and the debugger show the TypeScript. Only syntax errors
 * stop it; type errors are the code editor's business. Game builds (ADR 0041) pass
 * `sourceMap: false`, so they don't ship the TypeScript.
 */
export async function compileScript(path: string, source: string, options: { sourceMap?: boolean } = {}): Promise<Compiled | ScriptProblem> {
  const ts = await typescript();
  const sourceMap = options.sourceMap ?? true;
  const out = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
      inlineSourceMap: sourceMap,
      inlineSources: sourceMap,
    },
  });
  const error = out.diagnostics?.find((d) => d.category === ts.DiagnosticCategory.Error);
  if (error) {
    const where = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start) : null;
    const text = ts.flattenDiagnosticMessageText(error.messageText, "\n");
    return { path, message: where ? `line ${where.line + 1}: ${text}` : text };
  }
  return { path, code: out.outputText, imports: importSites(ts, out.outputText) };
}

/**
 * The script a relative specifier in `from` refers to, among `paths`: as written, or with `.ts`
 * added, `.js` swapped for `.ts` (the TypeScript convention), or `/index.ts`. Null if none.
 */
export function resolveScript(from: string, specifier: string, paths: ReadonlySet<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  const base = parts.join("/");
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`];
  return candidates.find((c) => paths.has(c)) ?? null;
}

/**
 * Scripts in load order: each after the scripts it imports. Scripts in an import cycle, or that
 * import a missing script, invalid JSON or a package that isn't available, are problems (and so is
 * anything that imports them); the rest still load. `json` maps the project's JSON files to
 * whether they parse; importing one isn't a dependency between scripts. `packages` maps the
 * package specifiers scripts import to why each can't load (undefined: it can), ADR 0125; without
 * it, packages aren't supported.
 */
export function loadOrder(
  scripts: ReadonlyMap<string, Compiled>,
  json: ReadonlyMap<string, boolean> = new Map(),
  packages?: ReadonlyMap<string, string | undefined>,
): { order: string[]; problems: ScriptProblem[]; deps: Map<string, string[]> } {
  const paths = new Set([...scripts.keys(), ...json.keys()]);
  const deps = new Map<string, string[]>();
  const problems = new Map<string, string>();
  for (const [path, s] of scripts) {
    const list: string[] = [];
    for (const imp of s.imports) {
      if (isEngineModule(imp.specifier)) continue;
      if (imp.specifier === EDITOR_MODULE) {
        if (!isEditorHalfPath(path)) problems.set(path, `can't import "${EDITOR_MODULE}": only a plugin's editor half (its editor/ folder) can, and it never ships in a game`);
        continue;
      }
      if (packages && isPackageSpecifier(imp.specifier)) {
        const why = packages.has(imp.specifier) ? packages.get(imp.specifier) : "it wasn't bundled";
        if (why !== undefined) problems.set(path, `can't import "${imp.specifier}": ${why}`);
        continue;
      }
      const target = resolveScript(path, imp.specifier, paths);
      if (target && isEditorHalfPath(target) && !isEditorHalfPath(path)) problems.set(path, `can't import ${target}: it is in a plugin's editor half, which only the editor loads`);
      else if (target && json.has(target)) {
        if (!json.get(target)) problems.set(path, `can't import ${target}: it isn't valid JSON`);
      } else if (target) list.push(target);
      else if (imp.specifier.startsWith(".")) problems.set(path, `can't find "${imp.specifier}"`);
      else problems.set(path, `can't import "${imp.specifier}": scripts can import "${ENGINE_MODULE}", other scripts, the project's JSON files and npm packages installed in the project folder`);
    }
    deps.set(path, [...new Set(list)]);
  }
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (path: string, stack: string[]): boolean => {
    if (state.get(path) === "done") return !problems.has(path);
    if (state.get(path) === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(path)), path];
      for (const p of cycle) problems.set(p, `import cycle: ${cycle.join(" → ")}`);
      return false;
    }
    state.set(path, "visiting");
    let ok = !problems.has(path);
    for (const d of deps.get(path)!) {
      if (!visit(d, [...stack, path])) {
        ok = false;
        if (!problems.has(path)) problems.set(path, `imports ${d}, which didn't load`);
      }
    }
    state.set(path, "done");
    if (ok && !problems.has(path)) order.push(path);
    return ok && !problems.has(path);
  };
  for (const path of [...scripts.keys()].sort()) visit(path, []);
  return { order, problems: [...problems].map(([path, message]) => ({ path, message })), deps };
}

const dataUrl = (code: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

/**
 * A URL to import `code` from: a `blob:` URL in browsers (WebKit gets `data:` module reloads
 * wrong), a `data:` URL elsewhere (Node, for tests, can't import `blob:`).
 */
const moduleUrl = (code: string) =>
  typeof Blob !== "undefined" && typeof document !== "undefined" ? URL.createObjectURL(new Blob([code], { type: "text/javascript" })) : dataUrl(code);

/** Blob URLs of the last load's modules, revoked once the next load has run. */
let lastUrls: string[] = [];

/**
 * A module that re-exports the editor SDK, for `import … from "myco/editor"` in plugins' editor halves
 * (ADR 0139). The editor sets `globalThis.__mycoEditor` (`plugins/thirdPartyEditor.ts`); elsewhere the
 * import fails with a message.
 */
function editorShimUrl(): string {
  const sdk = (globalThis as { __mycoEditor?: Record<string, unknown> }).__mycoEditor;
  if (!sdk) return dataUrl(`throw new Error(${JSON.stringify(`"${EDITOR_MODULE}" is only available in the editor`)});\n`);
  const names = Object.keys(sdk).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  return dataUrl(`const e = globalThis.__mycoEditor;\nexport const { ${names.join(", ")} } = e;\n`);
}

/** A module that re-exports the editor's engine, for `import … from "myco"`. */
function engineShimUrl(): string {
  const g = globalThis as { __myco?: unknown };
  g.__myco = engine;
  const names = Object.keys(engine).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  return dataUrl(`const e = globalThis.__myco;\nexport const { ${names.join(", ")} } = e;\n`);
}

let generation = 0;

export interface LoadResult {
  /** Scripts that loaded, in load order. */
  readonly loaded: readonly string[];
  readonly problems: readonly ScriptProblem[];
  /** The component, data component and system ids the scripts registered. */
  readonly registered: ScriptRegistrations;
}

/**
 * Compile and load `scripts` (project path → source), registering their components, data
 * components and systems. They can import the project's `json` files (project path → text). Registrations replace any with the same id or name (from the editor
 * build or an earlier load). A script that fails to compile or throws while loading is reported,
 * as is anything importing it; the others still load.
 */
export async function loadScripts(scripts: ReadonlyMap<string, string>, json: ReadonlyMap<string, string> = new Map(), packages?: PackageSource, extraPackages: readonly string[] = []): Promise<LoadResult> {
  // The prefabs and materials the scripts name, warmed up with every scene load (ADR 0080).
  setScriptAssetRefs(projectScriptAssetRefs(scripts.values(), (p) => engine.Assets.has(p) || engine.Assets.has(`asset:${p}`)));
  const problems: ScriptProblem[] = [];
  const compiled = new Map<string, Compiled>();
  for (const [path, source] of scripts) {
    if (!isScriptPath(path)) continue;
    const result = await compileScript(path, source);
    if ("code" in result) compiled.set(path, result);
    else problems.push(result);
  }
  const parsed = new Map<string, unknown>();
  for (const [path, text] of json) {
    try {
      parsed.set(path, JSON.parse(text));
    } catch {
      // reported against the scripts that import it
    }
  }
  // npm plugins' entry modules (ADR 0139) bundle with the packages the scripts import.
  lastSpecifiers = [...new Set([...packageSpecifiers(compiled.values()), ...extraPackages])].sort();
  const pkg = await loadPackages(lastSpecifiers, packages);
  const plan = loadOrder(compiled, new Map([...json.keys()].map((p) => [p, parsed.has(p)])), pkg.problems);
  problems.push(...plan.problems);
  const known = new Set([...compiled.keys(), ...json.keys()]);
  /** A module per imported JSON file, made when first needed. */
  const jsonUrls = new Map<string, string>();
  const jsonUrl = (path: string) => {
    if (!jsonUrls.has(path)) jsonUrls.set(path, moduleUrl(`export default ${JSON.stringify(parsed.get(path))};\n`));
    return jsonUrls.get(path)!;
  };

  // Every load gets fresh module URLs (a comment marks the generation), so a script whose text
  // didn't change still runs again.
  const stamp = `\n// myco-load ${++generation}\n`;
  const shim = engineShimUrl();
  const editorShim = [...compiled.values()].some((s) => s.imports.some((i) => i.specifier === EDITOR_MODULE)) ? editorShimUrl() : "";
  const urls = new Map<string, string>();
  const loaded: string[] = [];
  const registered = await withScriptRegistrations(async () => {
    for (const path of plan.order) {
      if (plan.deps.get(path)!.some((d) => !urls.has(d))) {
        problems.push({ path, message: `imports a script that didn't load` });
        continue;
      }
      const s = compiled.get(path)!;
      const code = rewriteImports(s.code, s.imports, (spec) => {
        if (isEngineModule(spec)) return shim;
        if (spec === EDITOR_MODULE) return editorShim;
        if (isPackageSpecifier(spec)) return pkg.urls.get(spec)!;
        const target = resolveScript(path, spec, known)!;
        return parsed.has(target) ? jsonUrl(target) : urls.get(target)!;
      });
      // No `//# sourceURL`: WebKit runs modules sharing one in a single scope, so a reload would
      // redeclare their classes. The inline source map names the file for the debugger.
      const url = moduleUrl(`${code}${stamp}`);
      try {
        await import(/* @vite-ignore */ url);
        urls.set(path, url);
        loaded.push(path);
      } catch (err) {
        problems.push({ path, message: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  for (const url of lastUrls) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  lastUrls = [...urls.values(), ...jsonUrls.values()];
  loadedModules = urls;
  return { loaded, problems, registered };
}

/** The package specifiers the last load's scripts import. */
let lastSpecifiers: string[] = [];

/** The npm package specifiers the loaded scripts import (ADR 0125), for the TypeScript service's package types. */
export const loadedPackageSpecifiers = (): readonly string[] => lastSpecifiers;

/** The package specifiers `scripts` import (ADR 0125). */
export function packageSpecifiers(scripts: Iterable<Compiled>): string[] {
  const out = new Set<string>();
  for (const s of scripts) for (const imp of s.imports) if (isPackageSpecifier(imp.specifier)) out.add(imp.specifier);
  return [...out].sort();
}

/** The loaded package bundle: its key, and each specifier's entry module URL. Kept across loads until the imports or the install change. */
let packageCache: { key: string; urls: Map<string, string>; problems: Map<string, string>; chunkUrls: string[] } | null = null;

/**
 * Bundle and load the packages `specifiers` name (ADR 0125), or reuse the last load's when the
 * specifiers and the installed packages are the same. Returns each specifier's module URL, and why
 * the others can't load.
 */
async function loadPackages(specifiers: readonly string[], source: PackageSource | undefined): Promise<{ urls: Map<string, string>; problems: Map<string, string | undefined> }> {
  const problems = new Map<string, string | undefined>();
  if (specifiers.length === 0) return { urls: new Map(), problems };
  if (!source) {
    for (const s of specifiers) problems.set(s, "npm packages load from a project folder's node_modules, and this project isn't a folder");
    return { urls: new Map(), problems };
  }
  const key = await packagesKey(specifiers, source);
  if (packageCache?.key !== key) {
    let bundle: PackageBundle;
    try {
      bundle = await bundlePackages(specifiers, source);
    } catch (err) {
      for (const s of specifiers) problems.set(s, `packages couldn't be bundled: ${err instanceof Error ? err.message : String(err)}`);
      return { urls: new Map(), problems };
    }
    const shim = engineShimUrl();
    const editorShim = editorShimUrl();
    const chunkUrls = new Map<string, string>();
    for (const name of chunkOrder(bundle)) {
      const chunk = bundle.chunks.get(name)!;
      const code = rewriteImports(chunk.code, chunk.imports, (spec) => (isEngineModule(spec) ? shim : spec === EDITOR_MODULE ? editorShim : spec.startsWith("./") ? (chunkUrls.get(spec.slice(2)) ?? spec) : spec));
      chunkUrls.set(name, moduleUrl(code));
    }
    for (const url of packageCache?.chunkUrls ?? []) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    const urls = new Map<string, string>();
    for (const [spec, entry] of bundle.entries) if (chunkUrls.has(entry)) urls.set(spec, chunkUrls.get(entry)!);
    packageCache = { key, urls, problems: new Map(bundle.problems), chunkUrls: [...chunkUrls.values()] };
  }
  for (const s of specifiers) problems.set(s, packageCache.urls.has(s) ? undefined : (packageCache.problems.get(s) ?? "it wasn't bundled"));
  return { urls: packageCache.urls, problems };
}

/**
 * The module of an npm package specifier the last load bundled (an npm plugin's entry, ADR 0139).
 * Throws if it wasn't bundled.
 */
export async function loadedPackageModule(specifier: string): Promise<Record<string, unknown>> {
  const url = packageCache?.urls.get(specifier);
  if (!url || !lastSpecifiers.includes(specifier)) throw new Error(`"${specifier}" isn't loaded${packageCache?.problems.get(specifier) ? `: ${packageCache.problems.get(specifier)}` : ""}.`);
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

/** The last load's module URLs, by script path. */
let loadedModules = new Map<string, string>();

/**
 * The module of a script the last load loaded (`import()` of its URL again gives the same module
 * instance without running it again), e.g. a code bootstrap for play mode. Throws if the script
 * didn't load.
 */
export async function loadedScriptModule(path: string): Promise<Record<string, unknown>> {
  const url = loadedModules.get(path);
  if (!url) throw new Error(`The script "${path}" isn't loaded: it doesn't exist, isn't under scripts/, or has a problem (see the status bar).`);
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}

/** What the current project's scripts registered (the last `replaceScripts`). */
let current: ScriptRegistrations = { components: [], data: [], systems: [], inputs: [] };

/** What the current project's scripts registered: what a reload during play swaps from (ADR 0125). */
export const loadedRegistrations = (): ScriptRegistrations => current;

/**
 * Load `scripts` in place of the scripts loaded before (a reload, or another project): their
 * types replace the old ones, and types the old scripts registered that the new ones don't (a
 * deleted script, a renamed id, one that failed to load) are unregistered, so scenes show them as
 * missing. Pass an empty map to unload everything.
 */
export async function replaceScripts(scripts: ReadonlyMap<string, string>, json: ReadonlyMap<string, string> = new Map(), packages?: PackageSource, extraPackages: readonly string[] = []): Promise<LoadResult> {
  const nothing = scripts.size === 0 && extraPackages.length === 0;
  if (nothing) {
    loadedModules = new Map();
    lastSpecifiers = [];
    setScriptAssetRefs([]);
  }
  const result = !nothing ? await loadScripts(scripts, json, packages, extraPackages) : { loaded: [], problems: [], registered: { components: [], data: [], systems: [], inputs: [] } };
  const gone = (old: string[], now: string[]) => old.filter((id) => !now.includes(id));
  unregisterScripts({
    components: gone(current.components, result.registered.components),
    data: gone(current.data, result.registered.data),
    systems: gone(current.systems, result.registered.systems),
    inputs: gone(current.inputs, result.registered.inputs),
  });
  current = result.registered;
  return result;
}
