// Project scripts (ADR 0030): the `.ts` files under a project's `scripts/` folder, compiled in the
// editor with the TypeScript compiler and loaded as ES modules. Each compiled module is loaded
// from a `data:` URL, so its imports are rewritten first: relative imports point at the other
// scripts' URLs (loaded before it), and `"tranquility"` points at a shim module that re-exports
// the editor's own engine. Scripts and the editor then share one registry and one World.
import * as engine from "../engine";
import { unregisterScripts, withScriptRegistrations, type ScriptRegistrations } from "../engine/editor";

/** The bare specifier scripts import the engine by. */
export const ENGINE_MODULE = "tranquility";

/** Where scripts live in a project, and which files count. */
export const isScriptPath = (path: string) => path.startsWith("scripts/") && path.endsWith(".ts") && !path.endsWith(".d.ts");

export interface ScriptProblem {
  readonly path: string;
  readonly message: string;
}

/** An import or export-from in compiled code: its specifier and where the specifier's text is. */
interface ImportSite {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

interface Compiled {
  readonly path: string;
  readonly code: string;
  readonly imports: readonly ImportSite[];
}

type TS = typeof import("typescript");
let tsModule: Promise<TS> | null = null;

/** The TypeScript compiler, loaded on first use (it's large, and only scripts need it). */
function typescript(): Promise<TS> {
  return (tsModule ??= import("typescript").then((m) => ((m as { default?: TS }).default ?? m) as TS));
}

/**
 * Compile one script to JavaScript with the editor's own settings (`typescriptTranspile()` in
 * vite.shared.ts: ES2022, ES modules, define-semantics class fields, standard decorators), with
 * an inline source map so stack traces and the debugger show the TypeScript. Only syntax errors
 * stop it; type errors are the code editor's business.
 */
export async function compileScript(path: string, source: string): Promise<Compiled | ScriptProblem> {
  const ts = await typescript();
  const out = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      useDefineForClassFields: true,
      inlineSourceMap: true,
      inlineSources: true,
    },
  });
  const error = out.diagnostics?.find((d) => d.category === ts.DiagnosticCategory.Error);
  if (error) {
    const where = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start) : null;
    const text = ts.flattenDiagnosticMessageText(error.messageText, "\n");
    return { path, message: where ? `line ${where.line + 1}: ${text}` : text };
  }
  // Imports, export-froms and dynamic imports with a literal specifier, with their positions.
  const info = ts.preProcessFile(out.outputText, true, true);
  // Positions start at the literal's quote; find the specifier's own text from there.
  const imports = info.importedFiles.map((f) => {
    const start = out.outputText.indexOf(f.fileName, f.pos);
    return { specifier: f.fileName, start, end: start + f.fileName.length };
  });
  return { path, code: out.outputText, imports };
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
 * import a missing script or an unsupported package, are problems (and so is anything that
 * imports them); the rest still load.
 */
export function loadOrder(scripts: ReadonlyMap<string, Compiled>): { order: string[]; problems: ScriptProblem[]; deps: Map<string, string[]> } {
  const paths = new Set(scripts.keys());
  const deps = new Map<string, string[]>();
  const problems = new Map<string, string>();
  for (const [path, s] of scripts) {
    const list: string[] = [];
    for (const imp of s.imports) {
      if (imp.specifier === ENGINE_MODULE) continue;
      const target = resolveScript(path, imp.specifier, paths);
      if (target) list.push(target);
      else if (imp.specifier.startsWith(".")) problems.set(path, `can't find "${imp.specifier}"`);
      else problems.set(path, `can't import "${imp.specifier}": scripts can import "${ENGINE_MODULE}" and other scripts only`);
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
  for (const path of [...paths].sort()) visit(path, []);
  return { order, problems: [...problems].map(([path, message]) => ({ path, message })), deps };
}

/** `code` with each import specifier replaced by what `urlFor` gives it (positions from `compileScript`). */
export function rewriteImports(code: string, imports: readonly ImportSite[], urlFor: (specifier: string) => string): string {
  let out = "";
  let at = 0;
  for (const imp of [...imports].sort((a, b) => a.start - b.start)) {
    out += code.slice(at, imp.start) + urlFor(imp.specifier);
    at = imp.end;
  }
  return out + code.slice(at);
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

/** A module that re-exports the editor's engine, for `import … from "tranquility"`. */
function engineShimUrl(): string {
  const g = globalThis as { __tranquility?: unknown };
  g.__tranquility = engine;
  const names = Object.keys(engine).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  return dataUrl(`const e = globalThis.__tranquility;\nexport const { ${names.join(", ")} } = e;\n`);
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
 * components and systems. Registrations replace any with the same id or name (from the editor
 * build or an earlier load). A script that fails to compile or throws while loading is reported,
 * as is anything importing it; the others still load.
 */
export async function loadScripts(scripts: ReadonlyMap<string, string>): Promise<LoadResult> {
  const problems: ScriptProblem[] = [];
  const compiled = new Map<string, Compiled>();
  for (const [path, source] of scripts) {
    if (!isScriptPath(path)) continue;
    const result = await compileScript(path, source);
    if ("code" in result) compiled.set(path, result);
    else problems.push(result);
  }
  const plan = loadOrder(compiled);
  problems.push(...plan.problems);

  // Every load gets fresh module URLs (a comment marks the generation), so a script whose text
  // didn't change still runs again.
  const stamp = `\n// tranquility-load ${++generation}\n`;
  const shim = engineShimUrl();
  const urls = new Map<string, string>();
  const loaded: string[] = [];
  const registered = await withScriptRegistrations(async () => {
    for (const path of plan.order) {
      if (plan.deps.get(path)!.some((d) => !urls.has(d))) {
        problems.push({ path, message: `imports a script that didn't load` });
        continue;
      }
      const s = compiled.get(path)!;
      const code = rewriteImports(s.code, s.imports, (spec) => (spec === ENGINE_MODULE ? shim : urls.get(resolveScript(path, spec, new Set(compiled.keys()))!)!));
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
  lastUrls = [...urls.values()];
  return { loaded, problems, registered };
}

/** What the current project's scripts registered (the last `replaceScripts`). */
let current: ScriptRegistrations = { components: [], data: [], systems: [] };

/**
 * Load `scripts` in place of the scripts loaded before (a reload, or another project): their
 * types replace the old ones, and types the old scripts registered that the new ones don't (a
 * deleted script, a renamed id, one that failed to load) are unregistered, so scenes show them as
 * missing. Pass an empty map to unload everything.
 */
export async function replaceScripts(scripts: ReadonlyMap<string, string>): Promise<LoadResult> {
  const result = scripts.size > 0 ? await loadScripts(scripts) : { loaded: [], problems: [], registered: { components: [], data: [], systems: [] } };
  const gone = (old: string[], now: string[]) => old.filter((id) => !now.includes(id));
  unregisterScripts({
    components: gone(current.components, result.registered.components),
    data: gone(current.data, result.registered.data),
    systems: gone(current.systems, result.registered.systems),
  });
  current = result.registered;
  return result;
}
