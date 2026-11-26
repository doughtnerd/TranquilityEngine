// Node-style module resolution over a project folder's files (ADR 0125), for packages.ts's esbuild
// plugin and its TypeScript declarations: `exports` maps (resolve.exports), then the
// `browser`/`module`/`main` fields, extension and index probing, nested node_modules, and a package's
// own subpath imports (`#internal`, its `imports` map). No file access of its own: callers give a
// `PackageFiles`. The game UI bundle (ADR 0421) resolves Svelte's runtime through it too.
import { imports as resolveImports, resolve as resolveExports } from "resolve.exports";

/** Read access to the project folder, by project-relative "/"-separated path; null when there's no such file. */
export interface PackageFiles {
  read(path: string): Promise<string | null>;
}

/** The package a specifier names: `lodash-es/debounce` → `lodash-es`, `@scope/pkg/x` → `@scope/pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Node's built-in modules: a package importing one (without a browser replacement) can't run in a game. */
const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(" "),
);
export const isNodeBuiltin = (specifier: string) => specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0]);

export const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** `path` with `.` and `..` segments folded. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

export const join = (dir: string, rel: string) => normalize(dir ? `${dir}/${rel}` : rel);

export interface PackageJson {
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
  private readonly conditions: string[];

  /** `conditions`: export conditions to match besides `browser`, `module`, `import` and `default` (such as `production`). */
  constructor(readonly files: PackageFiles, conditions: readonly string[] = []) {
    this.conditions = ["module", ...conditions];
  }

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
    if (specifier.startsWith("#")) {
      if (!owner) return { error: `"${specifier}": subpath imports resolve only inside packages` };
      let targets: readonly string[] | void;
      try {
        targets = resolveImports((await this.packageJson(owner)) ?? {}, specifier, { browser: true, conditions: this.conditions }) as readonly string[] | void;
      } catch (err) {
        return { error: `"${specifier}": ${err instanceof Error ? err.message : String(err)}` };
      }
      for (const target of targets ?? []) {
        if (!target.startsWith(".")) return this.resolve(target, importer);
        const file = join(owner, target);
        if (await this.isFile(file)) return { file };
      }
      return { error: `"${specifier}" isn't in ${owner.slice(owner.lastIndexOf("node_modules/") + "node_modules/".length)}'s imports` };
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
        targets = resolveExports(pkg, sub, { browser: true, conditions: this.conditions }) as readonly string[] | void;
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
