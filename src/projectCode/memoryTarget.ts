// The memory target of the project code linker (ADR 0329): each module becomes a URL and is imported
// into this JavaScript realm, for the editor (play mode shares the editor's registry and World) and the
// dedicated server. A module's imports point at the other modules' URLs (each imported before it), JSON
// files become modules exporting their contents, and `"myco"` points at a shim module re-exporting the
// host's engine. One instance per host holds what the last link loaded.
import { rewriteImports } from "../editor/moduleImports";
import { chunkOrder } from "../editor/packages";
import type { FoundPlugin } from "../plugins/thirdParty";
import { EDITOR_MODULE, isEngineModule } from "./compile";
import type { EmittedPackages, LinkTarget, TargetLink } from "./linker";

const dataUrl = (code: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

/**
 * A URL to import `code` from: a `blob:` URL in browsers (WebKit gets `data:` module reloads
 * wrong), a `data:` URL elsewhere (Node, for tests and the server, can't import `blob:`).
 */
const moduleUrl = (code: string) =>
  typeof Blob !== "undefined" && typeof document !== "undefined" ? URL.createObjectURL(new Blob([code], { type: "text/javascript" })) : dataUrl(code);

const revoke = (urls: Iterable<string>) => {
  for (const url of urls) if (url.startsWith("blob:")) URL.revokeObjectURL(url);
};

/** A shim module re-exporting the object at `globalThis[key]`'s identifier-named members. */
const shimUrl = (key: string, value: object) => {
  const names = Object.keys(value).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  return dataUrl(`const e = globalThis.${key};\nexport const { ${names.join(", ")} } = e;\n`);
};

/** Where the UI runtime modules the last links loaded are published (ADR 0423), by specifier, for their shims. */
const UI_RUNTIME_KEY = "__mycoUIRuntime";

/**
 * A shim module re-exporting UI runtime module `specifier` (already loaded): its named exports and its default.
 * Exports go through local names, since some are reserved words (Svelte's runtime exports `await`).
 */
const uiShimUrl = (specifier: string, value: object) => {
  const names = Object.keys(value).filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
  const read = `globalThis.${UI_RUNTIME_KEY}[${JSON.stringify(specifier)}]`;
  const locals = names.map((n, i) => `${JSON.stringify(n)}: $${i}`).join(", ");
  const exports = names.map((n, i) => `$${i} as ${n}`).join(", ");
  return dataUrl(`const e = ${read};\n${names.length ? `const { ${locals} } = e;\nexport { ${exports} };\n` : ""}${"default" in value ? "export default e.default;\n" : ""}`);
};


/** The host's own copy of a UI runtime module: Svelte's runtime and the engine's renderer, one instance with `UIView`'s. */
const loadUIRuntime = async (specifier: string): Promise<object> => (await import("../plugins/ui/svelte/runtimeModules")).loadUIRuntimeModule(specifier);


/**
 * The module for `import … from "myco/editor"` in plugins' editor halves (ADR 0139). The editor sets
 * `globalThis.__mycoEditor` (`plugins/thirdPartyEditor.ts`); elsewhere the import fails with a message.
 */
function editorShimUrl(): string {
  const sdk = (globalThis as { __mycoEditor?: Record<string, unknown> }).__mycoEditor;
  if (!sdk) return dataUrl(`throw new Error(${JSON.stringify(`"${EDITOR_MODULE}" is only available in the editor`)});\n`);
  return shimUrl("__mycoEditor", sdk);
}

/** The emitted packages, kept across links until the specifiers or the installed packages change. */
interface PackageCache extends EmittedPackages {
  readonly key: string;
  readonly chunkUrls: readonly string[];
}

/** Links code into module URLs and imports them (ADR 0329); keeps the last link's modules. */
export class MemoryTarget implements LinkTarget<void> {
  readonly sourceMap = true;
  readonly dev = true;
  /** UI runtime modules loaded so far, by specifier, and their shims (a module loads once per realm, so they're kept). */
  private uiModules = new Map<string, { value: object; shim: string }>();

  private generation = 0;
  /** The last link's script and JSON module URLs, revoked once the next link has run. */
  private lastUrls: string[] = [];
  private packageCache: PackageCache | null = null;
  /** The last link's script module URLs, by path. */
  private modules = new Map<string, string>();
  /** The last link's package entry URLs, by specifier. */
  private entries: ReadonlyMap<string, string> = new Map();

  /**
   * `engine` is the module scripts get for `import … from "myco"`: the host's own engine, so scripts
   * and the host share one registry and one World. It is published as `globalThis.__myco` (as the
   * player does, `player/main.ts`), which the shim reads, and for tests and the console.
   */
  constructor(private readonly engine: object) {
    (globalThis as { __myco?: unknown }).__myco = engine;
  }

  open(): TargetLink<void> {
    // Every link gets fresh module URLs (a comment marks the generation), so a script whose text didn't change still runs again.
    const stamp = `\n// myco-load ${++this.generation}\n`;
    let engineShim: string | undefined;
    let editorShim: string | undefined;
    const engine = () => (engineShim ??= shimUrl("__myco", this.engine));
    const editor = () => (editorShim ??= editorShimUrl());
    const urls = new Map<string, string>();
    const jsonUrls: string[] = [];
    let entries: ReadonlyMap<string, string> = new Map();
    return {
      packages: async (key, bundle) => {
        if (this.packageCache?.key !== key) {
          const made = await bundle();
          const chunkUrls = new Map<string, string>();
          for (const name of chunkOrder(made)) {
            const chunk = made.chunks.get(name)!;
            const code = rewriteImports(chunk.code, chunk.imports, (spec) => (isEngineModule(spec) ? engine() : spec === EDITOR_MODULE ? editor() : spec.startsWith("./") ? (chunkUrls.get(spec.slice(2)) ?? spec) : spec));
            chunkUrls.set(name, moduleUrl(code));
          }
          revoke(this.packageCache?.chunkUrls ?? []);
          const emitted = new Map<string, string>();
          for (const [spec, entry] of made.entries) if (chunkUrls.has(entry)) emitted.set(spec, chunkUrls.get(entry)!);
          this.packageCache = { key, bundle: made, entries: emitted, chunkUrls: [...chunkUrls.values()] };
        }
        entries = this.packageCache.entries;
        return this.packageCache;
      },
      json: (_path, value) => {
        const url = moduleUrl(`export default ${JSON.stringify(value)};\n`);
        jsonUrls.push(url);
        return url;
      },
      uiRuntime: async (specifiers) => {
        const published = ((globalThis as Record<string, unknown>)[UI_RUNTIME_KEY] ??= {}) as Record<string, object>;
        for (const s of specifiers) {
          if (this.uiModules.has(s)) continue;
          const value = await loadUIRuntime(s);
          published[s] = value;
          this.uiModules.set(s, { value, shim: uiShimUrl(s, value) });
        }
      },
      specifier: (_from, to) => {
        if ("engine" in to) return engine();
        if ("editorSdk" in to) return editor();
        if ("ui" in to) {
          const loaded = this.uiModules.get(to.ui);
          if (!loaded) throw new Error(`The UI runtime module "${to.ui}" isn't loaded.`);
          return loaded.shim;
        }
        return to.address;
      },

      script: async (path, code) => {
        // No `//# sourceURL`: WebKit runs modules sharing one in a single scope, so a reload would
        // redeclare their classes. The inline source map names the file for the debugger.
        const url = moduleUrl(`${code}${stamp}`);
        try {
          await import(/* @vite-ignore */ url);
        } catch (err) {
          revoke([url]);
          throw err;
        }
        urls.set(path, url);
        return url;
      },
      close: () => {
        revoke(this.lastUrls);
        this.lastUrls = [...urls.values(), ...jsonUrls];
        this.modules = urls;
        this.entries = entries;
      },
    };
  }

  /**
   * The module of a script the last link loaded (`import()` of its URL again gives the same module
   * instance without running it again), e.g. a code bootstrap. Throws if the script didn't load.
   */
  async scriptModule(path: string): Promise<Record<string, unknown>> {
    const url = this.modules.get(path);
    if (!url) throw new Error(`The script "${path}" isn't loaded: it doesn't exist, isn't under scripts/, or has a problem (see the status bar).`);
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  }

  /** The module of an npm package specifier the last link bundled (an npm plugin's entry, ADR 0139). Throws if it wasn't bundled. */
  async packageModule(specifier: string): Promise<Record<string, unknown>> {
    const url = this.entries.get(specifier);
    const why = this.packageCache?.bundle.problems.get(specifier);
    if (!url) throw new Error(`"${specifier}" isn't loaded${why ? `: ${why}` : ""}.`);
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
  }

  /**
   * A found plugin's half's entry module the last link loaded (ADR 0139, 0275): a project plugin's from
   * its scripts, an npm plugin's from the bundled packages. Undefined when the plugin has no such half;
   * throws when the entry didn't load.
   */
  async pluginModule(plugin: FoundPlugin, half: "runtime" | "editor"): Promise<Record<string, unknown> | undefined> {
    const entry = plugin[half];
    if (entry === undefined) return undefined;
    return plugin.source.kind === "project" ? this.scriptModule(entry) : this.packageModule(entry);
  }
}
