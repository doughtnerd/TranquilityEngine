// npm packages in project scripts (ADR 0125): bare imports resolved from the project folder's own
// node_modules and bundled with esbuild (its WebAssembly build: in the editor's page, and in Node
// for game builds and the dedicated server, so both produce the same code). esbuild can't read
// files there, so a plugin does Node's module resolution over `PackageFiles`: `exports` maps
// (resolve.exports), then the `browser`/`module`/`main` fields, extension and index probing, and
// nested node_modules. Every package specifier the scripts import is an entry point of one build
// with code splitting, so packages sharing a dependency share one copy.
//
// No file access here: callers give a `PackageFiles` reading the project folder (the editor through
// the platform FileSystem, Node through node:fs).
import type * as Esbuild from "esbuild-wasm";
import { resolve as resolveExports } from "resolve.exports";
import { importSites, typescript, type ImportSite } from "./moduleImports";

export type EsbuildApi = typeof Esbuild;

/** Read access to the project folder, by project-relative "/"-separated path; null when there's no such file. */
export interface PackageFiles {
  read(path: string): Promise<string | null>;
}

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

const ENGINE_SPECIFIERS = new Set(["myco", "tranquility"]);

/** True for an import of an npm package: a bare specifier other than the engine's. */
export const isPackageSpecifier = (specifier: string) =>
  !ENGINE_SPECIFIERS.has(specifier) && !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(specifier);

/** The package a specifier names: `lodash-es/debounce` → `lodash-es`, `@scope/pkg/x` → `@scope/pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Node's built-in modules: a package importing one (without a browser replacement) can't run in a game. */
const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(" "),
);
const isNodeBuiltin = (specifier: string) => specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]);

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** `path` with `.` and `..` segments folded. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

const join = (dir: string, rel: string) => normalize(dir ? `${dir}/${rel}` : rel);

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  browser?: string | Record<string, string | false>;
  exports?: unknown;
  types?: string;
  typings?: string;
}

/** What a specifier resolved to: a file in the project, an empty module (`browser: { x: false }`), or why not. */
export type Resolved = { file: string } | { empty: true } | { error: string };

/**
 * Node-style resolution over `PackageFiles`, with a cache per instance (one per bundle). Paths are
 * project-relative; the project root's node_modules is `node_modules/`.
 */
export class PackageResolver {
  private readonly texts = new Map<string, Promise<string | null>>();

  constructor(readonly files: PackageFiles) {}

  read(path: string): Promise<string | null> {
    let text = this.texts.get(path);
    if (!text) this.texts.set(path, (text = this.files.read(path).catch(() => null)));
    return text;
  }

  private async packageJson(dir: string): Promise<PackageJson | null> {
    const text = await this.read(`${dir}/package.json`);
    if (text === null) return null;
    try {
      return JSON.parse(text) as PackageJson;
    } catch {
      return null;
    }
  }

  /** The folder of package `name` seen from `fromDir`: the nearest `node_modules/<name>` walking up. */
  async packageDir(name: string, fromDir: string): Promise<string | null> {
    for (let dir = fromDir; ; dir = dirname(dir)) {
      if (!dir.endsWith("/node_modules") && dir !== "node_modules") {
        const candidate = join(dir, `node_modules/${name}`);
        if (await this.read(`${candidate}/package.json`)) return candidate;
      }
      if (dir === "") return null;
    }
  }

  /** A file at `base`, as written or with an extension or index file added (and a folder's own package.json `main`). */
  private async probe(base: string): Promise<string | null> {
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`]) {
      if (await this.isFile(candidate)) return candidate;
    }
    const pkg = await this.packageJson(base);
    const main = pkg && (typeof pkg.browser === "string" ? pkg.browser : (pkg.module ?? pkg.main));
    if (main) {
      const found = await this.probeFile(join(base, main));
      if (found) return found;
    }
    for (const index of ["index.js", "index.mjs", "index.cjs", "index.json"]) {
      if (await this.isFile(`${base}/${index}`)) return `${base}/${index}`;
    }
    return null;
  }

  private async probeFile(path: string): Promise<string | null> {
    for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, `${path}.json`, `${path}/index.js`]) {
      if (await this.isFile(candidate)) return candidate;
    }
    return null;
  }

  private async isFile(path: string): Promise<boolean> {
    return path !== "" && !path.endsWith("/") && (await this.read(path)) !== null;
  }

  /** The package folder (`…/node_modules/<name>`) a file is inside, or null for project files. */
  private owningPackage(file: string): string | null {
    const at = file.lastIndexOf("node_modules/");
    if (at < 0) return null;
    const rest = file.slice(at + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
    return file.slice(0, at) + "node_modules/" + name;
  }

  /** A package's `browser` field mapping for `key` (a bare name, or "./file" inside the package): the replacement, false, or undefined. */
  private async browserMap(pkgDir: string, key: string): Promise<string | false | undefined> {
    const pkg = await this.packageJson(pkgDir);
    if (!pkg || typeof pkg.browser !== "object" || pkg.browser === null) return undefined;
    const map = pkg.browser;
    for (const k of [key, key.replace(/\.js$/, ""), `${key}.js`]) if (k in map) return map[k];
    return undefined;
  }

  /** Resolve `specifier` imported from `importer` (a project path; "" for the project itself). */
  async resolve(specifier: string, importer: string): Promise<Resolved> {
    const fromDir = dirname(importer);
    const owner = importer ? this.owningPackage(importer) : null;
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
      let target = specifier.startsWith("/") ? normalize(specifier) : join(fromDir, specifier);
      if (owner) {
        const mapped = await this.browserMap(owner, `./${target.slice(owner.length + 1)}`);
        if (mapped === false) return { empty: true };
        if (typeof mapped === "string") target = join(owner, mapped);
      }
      const file = await this.probe(target);
      return file ? { file } : { error: `can't find "${specifier}" from ${importer || "the project"}` };
    }
    if (owner) {
      const mapped = await this.browserMap(owner, specifier);
      if (mapped === false) return { empty: true };
      if (typeof mapped === "string") return mapped.startsWith(".") ? this.resolve(mapped, `${owner}/package.json`) : this.resolve(mapped, importer);
    }
    if (isNodeBuiltin(specifier)) {
      return { error: `needs Node's "${specifier.replace(/^node:/, "")}" module, which games don't have` };
    }
    const name = packageName(specifier);
    const dir = await this.packageDir(name, fromDir);
    if (!dir) return { error: `"${name}" isn't installed: run npm install in the project folder` };
    const pkg = (await this.packageJson(dir)) ?? {};
    const sub = specifier.length > name.length ? `.${specifier.slice(name.length)}` : ".";
    if (pkg.exports !== undefined) {
      let targets: readonly string[] | void;
      try {
        targets = resolveExports(pkg, sub, { browser: true, conditions: ["module"] }) as readonly string[] | void;
      } catch (err) {
        return { error: `"${specifier}": ${err instanceof Error ? err.message : String(err)}` };
      }
      for (const target of targets ?? []) {
        const file = join(dir, target);
        if (await this.isFile(file)) return { file };
      }
      return { error: `"${specifier}" isn't exported by ${name}` };
    }
    if (sub === ".") {
      const fields = [typeof pkg.browser === "string" ? pkg.browser : undefined, pkg.module, pkg.main].filter((f): f is string => !!f);
      for (const field of fields) {
        let target = field;
        const mapped = await this.browserMap(dir, `./${normalize(field)}`);
        if (mapped === false) return { empty: true };
        if (typeof mapped === "string") target = mapped;
        const file = await this.probeFile(join(dir, target));
        if (file) return { file };
      }
      const file = await this.probe(join(dir, "index"));
      return file ? { file } : { error: `"${name}" has no entry file` };
    }
    const mapped = await this.browserMap(dir, sub);
    if (mapped === false) return { empty: true };
    const file = await this.probe(join(dir, typeof mapped === "string" ? mapped : sub));
    return file ? { file } : { error: `can't find "${specifier}" in ${name}` };
  }
}

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
