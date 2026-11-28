// npm packages in project scripts (ADR 0125): bare imports resolved from the project folder's own
// node_modules and bundled with esbuild (its WebAssembly build: in the editor's page, and in Node
// for game builds and the dedicated server, so both produce the same code). esbuild can't read
// files there, so a plugin does Node's module resolution over `PackageFiles` (packageResolver.ts): `exports` maps
// (resolve.exports), then the `browser`/`module`/`main` fields, extension and index probing, and
// nested node_modules. Every package specifier the scripts import is an entry point of one build
// with code splitting, so packages sharing a dependency share one copy.
//
// No file access here: callers give a `PackageFiles` reading the project folder (the editor through
// the platform FileSystem, Node through node:fs).
import type * as Esbuild from "esbuild-wasm";
import { resolve as resolveExports } from "resolve.exports";
import { importSites, typescript, type ImportSite } from "./moduleImports";
import { PackageResolver, dirname, isNodeBuiltin, join, packageName, type PackageFiles, type PackageJson } from "./packageResolver";
import { isUIRuntimeSpecifier } from "../projectCode/uiModules";


export type { PackageFiles } from "./packageResolver";

export type EsbuildApi = typeof Esbuild;

/** Where packages come from and how they're bundled. */
export interface PackageSource {
  readonly files: PackageFiles;
  /** esbuild, initialised (loaded on first use: only projects importing packages pay for it). */
  readonly esbuild: () => Promise<EsbuildApi>;
  /** `process.env.NODE_ENV` in package code: "development" in the editor, "production" in builds. */
  readonly mode: "development" | "production";
  /** Which project this is (its folder), so two projects never share a cached bundle. */
  readonly id?: string;
}

// "myco/editor" (ADR 0139): the editor SDK, which npm plugins' editor halves import; external like "myco".
const ENGINE_SPECIFIERS = new Set(["myco", "tranquility", "myco/editor"]);

/** True for an import of an npm package: a bare specifier other than the engine's and the UI runtime's (Svelte, ADR 0423). */
export const isPackageSpecifier = (specifier: string) =>
  !ENGINE_SPECIFIERS.has(specifier) && !isUIRuntimeSpecifier(specifier) &&
 !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);


/** One output module of a package bundle, its imports found (other chunks, and the engine). */
export interface PackageChunk {
  readonly code: string;
  readonly imports: readonly ImportSite[];
}

/** The bundled packages: chunk files by name, and the entry chunk each specifier loads. */
export interface PackageBundle {
  /** Specifier → its entry chunk's file name. */
  readonly entries: ReadonlyMap<string, string>;
  /** Chunk file name (`pkg_mitt.js`, `chunk-ABCD.js`) → code. Chunks import each other as `./<name>`. */
  readonly chunks: ReadonlyMap<string, PackageChunk>;
  /** Specifiers that couldn't be bundled, with why. */
  readonly problems: ReadonlyMap<string, string>;
}

const LOADERS: Record<string, Esbuild.Loader> = { js: "js", mjs: "js", cjs: "js", jsx: "jsx", json: "json", ts: "ts", mts: "ts", cts: "ts", tsx: "tsx" };
const loaderFor = (path: string): Esbuild.Loader => LOADERS[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "empty";

/** A file-name-safe entry name for a specifier. */
const entryName = (specifier: string, index: number) => `pkg${index}_${specifier.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;

/** esbuild's plugin resolving through `resolver` (files in the `pkg` namespace, empty modules in `empty`). */
function resolverPlugin(resolver: PackageResolver, entries: ReadonlyMap<string, string>): Esbuild.Plugin {
  return {
    name: "myco-node-modules",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (ENGINE_SPECIFIERS.has(args.path)) return { path: args.path, external: true };
        const specifier = args.kind === "entry-point" ? (entries.get(args.path) ?? args.path) : args.path;
        const importer = args.kind === "entry-point" ? "" : args.importer;
        const result = await resolver.resolve(specifier, importer);
        if ("file" in result) return { path: result.file, namespace: "pkg" };
        if ("empty" in result) return { path: specifier, namespace: "empty" };
        return { errors: [{ text: result.error }] };
      });
      build.onLoad({ filter: /.*/, namespace: "pkg" }, async (args) => {
        const contents = await resolver.read(args.path);
        if (contents === null) return { errors: [{ text: `can't read ${args.path}` }] };
        return { contents, loader: loaderFor(args.path), resolveDir: dirname(args.path) };
      });
      build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "module.exports = {};", loader: "js" }));
    },
  };
}

/** Run one esbuild bundle of `specifiers`; throws esbuild's failure. */
async function runBundle(esbuild: EsbuildApi, resolver: PackageResolver, specifiers: readonly string[], mode: PackageSource["mode"]): Promise<{ entries: Map<string, string>; chunks: Map<string, string> }> {
  const names = new Map(specifiers.map((s, i) => [entryName(s, i), s]));
  const result = await esbuild.build({
    entryPoints: [...names.keys()].map((name) => ({ in: name, out: name })),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: "/deps",
    write: false,
    logLevel: "silent",
    minify: mode === "production",
    define: { "process.env.NODE_ENV": JSON.stringify(mode), global: "globalThis" },
    plugins: [resolverPlugin(resolver, names)],
  });
  const chunks = new Map<string, string>();
  for (const file of result.outputFiles ?? []) chunks.set(file.path.slice(file.path.replace(/\\/g, "/").lastIndexOf("/") + 1), file.text);
  const entries = new Map<string, string>();
  for (const [name, specifier] of names) entries.set(specifier, `${name}.js`);
  return { entries, chunks };
}

const failureText = (err: unknown): string => {
  const errors = (err as { errors?: { text: string }[] })?.errors;
  return errors?.length ? errors.map((e) => e.text).join("; ") : err instanceof Error ? err.message : String(err);
};

/**
 * Bundle `specifiers` (package imports, as the scripts write them) from the project's
 * node_modules. A specifier that doesn't resolve is a problem on its own; if the rest fail to
 * bundle together, each is bundled alone to find which.
 */
export async function bundlePackages(specifiers: readonly string[], source: PackageSource): Promise<PackageBundle> {
  const resolver = new PackageResolver(source.files);
  const problems = new Map<string, string>();
  const ok: string[] = [];
  for (const specifier of [...new Set(specifiers)].sort()) {
    const result = await resolver.resolve(specifier, "");
    if ("error" in result) problems.set(specifier, result.error);
    else ok.push(specifier);
  }
  const ts = await typescript();
  const done = (entries: Map<string, string>, raw: Map<string, string>): PackageBundle => {
    const chunks = new Map<string, PackageChunk>();
    for (const [name, code] of raw) chunks.set(name, { code, imports: importSites(ts, code) });
    return { entries, chunks, problems };
  };
  if (ok.length === 0) return { entries: new Map(), chunks: new Map(), problems };
  const esbuild = await source.esbuild();
  try {
    const { entries, chunks } = await runBundle(esbuild, resolver, ok, source.mode);
    return done(entries, chunks);
  } catch (err) {
    if (ok.length === 1) {
      problems.set(ok[0], failureText(err));
      return { entries: new Map(), chunks: new Map(), problems };
    }
  }
  // Find which specifiers fail, then bundle the rest together.
  const good: string[] = [];
  for (const specifier of ok) {
    try {
      await runBundle(esbuild, resolver, [specifier], source.mode);
      good.push(specifier);
    } catch (err) {
      problems.set(specifier, failureText(err));
    }
  }
  if (good.length === 0) return { entries: new Map(), chunks: new Map(), problems };
  const { entries, chunks } = await runBundle(esbuild, resolver, good, source.mode);
  return done(entries, chunks);
}

/** Chunks in load order: each after the chunks it imports. */
export function chunkOrder(bundle: PackageBundle): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const imp of bundle.chunks.get(name)?.imports ?? []) {
      if (imp.specifier.startsWith("./")) visit(imp.specifier.slice(2));
    }
    order.push(name);
  };
  for (const name of [...bundle.chunks.keys()].sort()) visit(name);
  return order;
}

/** A cache key for bundling `specifiers`: they and the installed packages (npm's lock in node_modules, else package.json). */
export async function packagesKey(specifiers: readonly string[], source: PackageSource): Promise<string> {
  const lock = (await source.files.read("node_modules/.package-lock.json").catch(() => null)) ?? (await source.files.read("package.json").catch(() => null)) ?? "";
  return `${source.mode}\n${[...new Set(specifiers)].sort().join("\n")}\n${lock}`;
}

// --- Types for the Code panel and the type check ---------------------------------------------------

/** At most this many declaration files are read for a project's packages, so a huge type tree can't stall the editor. */
const MAX_TYPE_FILES = 3000;

/**
 * The declaration files the TypeScript service needs for `specifiers`: each package's declarations
 * (`types`/`typings`/`exports` types, else `@types/<name>`) and every `.d.ts` they reference,
 * by project path (`node_modules/…`), with the packages' `package.json` files. Specifiers with
 * no declarations get a shorthand ambient module (`declare module "x";`) under `untyped`.
 */
export async function packageTypes(specifiers: readonly string[], files: PackageFiles): Promise<{ files: Map<string, string>; untyped: string[] }> {
  const resolver = new PackageResolver(files);
  const ts = await typescript();
  const out = new Map<string, string>();
  const untyped: string[] = [];
  const queue: string[] = [];
  const add = async (path: string): Promise<boolean> => {
    if (out.has(path)) return true;
    const text = await resolver.read(path);
    if (text === null) return false;
    out.set(path, text);
    if (path.endsWith(".ts")) queue.push(path);
    return true;
  };
  /** The declaration entry of package folder `dir` for subpath `sub`; adds its package.json. */
  const entryOf = async (dir: string, sub: string): Promise<string | null> => {
    const pkgText = await resolver.read(`${dir}/package.json`);
    if (pkgText === null) return null;
    out.set(`${dir}/package.json`, pkgText);
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(pkgText) as PackageJson;
    } catch {
      return null;
    }
    const candidates: string[] = [];
    if (pkg.exports !== undefined) {
      try {
        for (const t of (resolveExports(pkg, sub, { browser: true, conditions: ["types", "module"] }) as string[] | void) ?? []) candidates.push(t);
      } catch {
        // not exported: try the fields below
      }
    }
    if (sub === ".") candidates.push(...[pkg.types, pkg.typings].filter((t): t is string => !!t), "index.d.ts");
    else candidates.push(`${sub}.d.ts`, `${sub}/index.d.ts`);
    for (const c of candidates) {
      const base = join(dir, c);
      for (const path of [base, base.replace(/\.(m|c)?js$/, ".d.$1ts")]) {
        if (/\.d\.(m|c)?ts$/.test(path) && (await add(path))) return path;
      }
    }
    return null;
  };
  const typesFor = async (specifier: string, fromDir: string): Promise<boolean> => {
    const name = packageName(specifier);
    const sub = specifier.length > name.length ? `.${specifier.slice(name.length)}` : ".";
    const dir = await resolver.packageDir(name, fromDir);
    if (dir && (await entryOf(dir, sub))) return true;
    const typesName = name.startsWith("@") ? name.slice(1).replace("/", "__") : name;
    const typesDir = await resolver.packageDir(`@types/${typesName}`, fromDir);
    return !!typesDir && !!(await entryOf(typesDir, sub));
  };
  for (const specifier of [...new Set(specifiers)].sort()) {
    if (!(await typesFor(specifier, ""))) untyped.push(specifier);
  }
  while (queue.length && out.size < MAX_TYPE_FILES) {
    const path = queue.shift()!;
    const info = ts.preProcessFile(out.get(path)!, true, true);
    const dir = dirname(path);
    for (const ref of info.referencedFiles) await add(join(dir, ref.fileName));
    for (const ref of info.typeReferenceDirectives) await typesFor(ref.fileName, dir);
    for (const imp of info.importedFiles) {
      const spec = imp.fileName;
      if (ENGINE_SPECIFIERS.has(spec)) continue;
      if (spec.startsWith(".")) {
        const base = join(dir, spec).replace(/\.(m|c)?js$/, "");
        for (const c of [`${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`, `${base}/index.d.ts`, `${base}.ts`]) if (await add(c)) break;
      } else if (!isNodeBuiltin(spec)) await typesFor(spec, dir);
    }
  }
  return { files: out, untyped };
}
