// The project code linker (ADR 0329): one pipeline turns a project's selected code (its scripts and
// enabled plugins' files, `planPluginCode`, ADR 0275) into modules a host can run. Compile each script
// (ADR 0030), parse the JSON files scripts may import, collect the npm package specifiers the scripts
// import plus the npm plugins' entries (ADR 0125, 0139), bundle them, order the scripts, and rewrite
// every import to where its module is. Only the destination differs between hosts, so it sits behind
// one seam, `LinkTarget`, with two adapters: the memory target (`memoryTarget.ts`: module URLs,
// imported, for the editor and the dedicated server) and the build target (`buildTarget.ts`: files
// under `code/` for a game build, ADR 0041).
//
// The linker decides what a problem is, in one list, for every host; the host decides what a problem
// means (the editor shows it in the status line and loads the rest; a build and the server stop).
import { projectScriptAssetRefs } from "../engine/scene/scriptAssetRefs";
import { rewriteImports } from "../editor/moduleImports";
import { bundlePackages, isPackageSpecifier, packagesKey, type PackageBundle, type PackageSource } from "../editor/packages";
import { isScriptPath } from "../editor/projectPaths";
import { compileScript, EDITOR_MODULE, isEngineModule, resolveScript, type CompiledScript, type ScriptProblem } from "./compile";
import { compileUI } from "./compileUI";
import { loadOrder } from "./loadOrder";
import { isUIRuntimeSpecifier, isUISourcePath } from "./uiModules";


/** What to link: a host's selection of a project's code. */
export interface LinkInput {
  /** Scripts' and plugin files' source by project path (`planPluginCode`'s `code`); other paths are ignored. */
  readonly code: ReadonlyMap<string, string>;
  /** The project's JSON files' text by path; scripts can import them. */
  readonly json?: ReadonlyMap<string, string>;
  /**
   * The project's UI code by path (ADR 0419): Svelte components (`*.svelte`) and rune modules
   * (`*.svelte.ts`), which compile and load like scripts, and its `.css` files, of which those that UI code
   * imports compile to modules registering their rules. Other paths are ignored.
   */
  readonly ui?: ReadonlyMap<string, string>;

  /** The project's node_modules, for npm package imports (ADR 0125); without it, a package import is a problem. */
  readonly packages?: PackageSource;
  /** npm plugin entries to bundle with the packages (`planPluginCode`'s `npmEntries`, ADR 0139); one that can't be bundled is a problem. */
  readonly extraEntries?: readonly string[];
  /** Whether a path the code names is one of the project's files: the asset references are those that are (ADR 0080). */
  readonly isAsset?: (path: string) => boolean;
}

/** A target's emitted packages: the bundle (for its problems), and the address of each entry it emitted. */
export interface EmittedPackages {
  readonly bundle: PackageBundle;
  readonly entries: ReadonlyMap<string, string>;
}

/** One link into a target, opened by `LinkTarget.open`. Addresses are what the target's modules import each other by. */
export interface TargetLink<Output> {
  /**
   * Emit the bundled packages: `bundle` makes the bundle (it throws when bundling fails); a target may
   * reuse what it emitted for the same `key` (the specifiers and the installed packages) instead.
   */
  packages(key: string, bundle: () => Promise<PackageBundle>): Promise<EmittedPackages>;
  /**
   * Get the UI runtime modules the code imports ready before any `specifier` names them (ADR 0419), when the
   * target needs to (the memory target loads the host's own copies). Throws when one can't load.
   */
  uiRuntime?(specifiers: readonly string[]): Promise<void>;
  /** Emit the module of a JSON file a script imports (called once per file); its address. */

  json(path: string, value: unknown): string;
  /**
   * What script `from` writes to import the engine (`"myco"`), the editor SDK (`"myco/editor"`), a UI runtime
   * module (`ui`: Svelte's runtime or the engine's renderer, ADR 0419, provided by the host), or the module at `address`.
   */
  specifier(from: string, to: { readonly engine: true } | { readonly editorSdk: true } | { readonly ui: string } | { readonly address: string }): string;

  /** Emit script `path`'s rewritten module, after the modules it imports; its address. Throws when the module fails to load. */
  script(path: string, code: string): Promise<string>;
  /** The link is done: `loaded` are the scripts emitted, in order. */
  close(loaded: readonly string[]): Output;
}

/** Where linked code goes: the seam between the linker and a host's destination. */
export interface LinkTarget<Output> {
  /** Whether compiled scripts carry inline source maps (the TypeScript, for the debugger). */
  readonly sourceMap: boolean;
  /** Whether UI components compile in Svelte's dev mode (template locations, for the editor's picking; ADR 0419). */
  readonly dev: boolean;

  open(): TargetLink<Output>;
}

/** A link's result, the same for every target. */
export interface Linked<Output> {
  /** Scripts that linked, in load order. */
  readonly loaded: readonly string[];
  /** Every problem: scripts that don't compile, unsatisfied imports, modules that failed to load, plugin entries that can't be bundled. */
  readonly problems: readonly ScriptProblem[];
  /** The project files the linked code names, which scene loads warm up (ADR 0080). */
  readonly assetRefs: readonly string[];
  /** The npm package specifiers bundled: the scripts' imports and the plugin entries (ADR 0125, 0139). */
  readonly specifiers: readonly string[];
  /** Each bundled specifier's entry module address. */
  readonly entries: ReadonlyMap<string, string>;
  /** What the target made. */
  readonly output: Output;
}

const byPath = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** Why every specifier can't load when there's no node_modules to bundle from. */
const NO_PACKAGES = "npm packages load from the project folder's node_modules, and this project has none";

/** Link `input` into `target` (ADR 0329). Never throws for a problem in the project's code: it is in `problems`. */
export async function link<Output>(input: LinkInput, target: LinkTarget<Output>): Promise<Linked<Output>> {
  const json = input.json ?? new Map<string, string>();
  const extraEntries = input.extraEntries ?? [];
  const ui = input.ui ?? new Map<string, string>();
  const uiSources = [...ui].filter(([path]) => isUISourcePath(path));
  const code = [...input.code, ...uiSources].filter(([path], i, all) => (isScriptPath(path) || isUISourcePath(path)) && all.findIndex(([p]) => p === path) === i).sort(byPath);
  const assetRefs = input.isAsset ? projectScriptAssetRefs(code.map(([, source]) => source), input.isAsset) : [];

  const problems: ScriptProblem[] = [];
  const compiled = new Map<string, CompiledScript>();
  for (const [path, source] of code) {
    const result = isUISourcePath(path) ? await compileUI(path, source, { dev: target.dev }) : await compileScript(path, source, { sourceMap: target.sourceMap });
    if ("code" in result) compiled.set(path, result);
    else problems.push(result);
  }
  // The `.css` files UI code imports (ADR 0419): each a module registering its rules, loaded before what imports it.
  const cssPaths = new Set([...ui.keys()].filter((p) => p.endsWith(".css")));
  for (const s of [...compiled.values()]) {
    if (!isUISourcePath(s.path)) continue;
    for (const imp of s.imports) {
      const css = imp.specifier.endsWith(".css") ? resolveScript(s.path, imp.specifier, cssPaths) : null;
      if (!css || compiled.has(css)) continue;
      const result = await compileUI(css, ui.get(css)!, { dev: target.dev });
      if ("code" in result) compiled.set(css, result);
      else problems.push(result);
    }
  }

  const parsed = new Map<string, unknown>();
  for (const [path, text] of json) {
    try {
      parsed.set(path, JSON.parse(text));
    } catch {
      // reported against the scripts that import it
    }
  }

  const out = target.open();
  const uiSpecifiers = [...new Set([...compiled.values()].flatMap((s) => s.imports.map((i) => i.specifier)).filter(isUIRuntimeSpecifier))].sort();
  if (uiSpecifiers.length > 0 && out.uiRuntime) {
    try {
      await out.uiRuntime(uiSpecifiers);
    } catch (err) {
      for (const s of [...compiled.values()]) {
        if (!s.imports.some((i) => isUIRuntimeSpecifier(i.specifier))) continue;
        compiled.delete(s.path);
        problems.push({ path: s.path, message: `the UI runtime (Svelte) didn't load: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  const specifiers = [...new Set([...packageSpecifiers(compiled.values()), ...extraEntries])].sort();
  const packageProblems = new Map<string, string | undefined>();
  let entries: ReadonlyMap<string, string> = new Map();
  if (specifiers.length > 0 && !input.packages) for (const s of specifiers) packageProblems.set(s, NO_PACKAGES);
  else if (specifiers.length > 0 && input.packages) {
    const source = input.packages;
    try {
      const emitted = await out.packages(await packagesKey(specifiers, source), () => bundlePackages(specifiers, source));
      entries = emitted.entries;
      for (const s of specifiers) packageProblems.set(s, entries.has(s) ? undefined : (emitted.bundle.problems.get(s) ?? "it wasn't bundled"));
    } catch (err) {
      for (const s of specifiers) packageProblems.set(s, `packages couldn't be bundled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const plan = loadOrder(compiled, new Map([...json.keys()].map((p) => [p, parsed.has(p)])), packageProblems);
  problems.push(...plan.problems);
  for (const spec of extraEntries) {
    const why = packageProblems.get(spec);
    if (why !== undefined) problems.push({ path: spec, message: `the plugin entry can't be bundled: ${why}` });
  }

  const known = new Set([...compiled.keys(), ...json.keys()]);
  const jsonAddresses = new Map<string, string>();
  const addresses = new Map<string, string>();
  const loaded: string[] = [];
  for (const path of plan.order) {
    if (plan.deps.get(path)!.some((d) => !addresses.has(d))) {
      problems.push({ path, message: "imports a script that didn't load" });
      continue;
    }
    const s = compiled.get(path)!;
    const rewritten = rewriteImports(s.code, s.imports, (spec) => {
      if (isEngineModule(spec)) return out.specifier(path, { engine: true });
      if (spec === EDITOR_MODULE) return out.specifier(path, { editorSdk: true });
      if (isUIRuntimeSpecifier(spec)) return out.specifier(path, { ui: spec });

      if (isPackageSpecifier(spec)) return out.specifier(path, { address: entries.get(spec)! });
      const target = resolveScript(path, spec, known)!;
      if (!parsed.has(target)) return out.specifier(path, { address: addresses.get(target)! });
      if (!jsonAddresses.has(target)) jsonAddresses.set(target, out.json(target, parsed.get(target)));
      return out.specifier(path, { address: jsonAddresses.get(target)! });
    });
    try {
      addresses.set(path, await out.script(path, rewritten));
      loaded.push(path);
    } catch (err) {
      problems.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { loaded, problems, assetRefs, specifiers, entries, output: out.close(loaded) };
}

/** The package specifiers `scripts` import (ADR 0125). */
function packageSpecifiers(scripts: Iterable<CompiledScript>): string[] {
  const out = new Set<string>();
  for (const s of scripts) for (const imp of s.imports) if (isPackageSpecifier(imp.specifier)) out.add(imp.specifier);
  return [...out];
}
