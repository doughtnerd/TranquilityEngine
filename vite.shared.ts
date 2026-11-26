import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Plugin, Rollup, UserConfig } from "vite";
import { compilerOptions as scriptCompilerOptions, SCRIPT_EMIT } from "./src/scriptCompiler.mjs";
import { ENGINE_SOURCE_DIR, UI_HOST_FILE } from "./src/projectCode/uiModules";


/**
 * Compile TypeScript (and TSX) with tsc instead of Vite's default transformer (oxc), which does
 * not lower standard ES decorators (used for scene field declarations, see ADR 0013). JSX is
 * compiled for Preact, which the editor UI uses (ADR 0025). Used by the dev server, all builds
 * and Vitest, so they emit the same code. Configs that use it must also set `oxc: false`.
 */
export function typescriptTranspile(): Plugin {
  const compilerOptions: ts.CompilerOptions = {
    ...scriptCompilerOptions(SCRIPT_EMIT), // the emit settings every host shares (ADR 0332)
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource: "preact",
    sourceMap: true,
    inlineSources: true,
  };
  // tsc takes ~3 s for the editor's files, every time a dev server or test run starts, so its output
  // is kept on disk: one entry per source file, reused while the file, tsc and these options match.
  const version = `${ts.version}:${JSON.stringify(compilerOptions)}`;
  return {
    name: "myco:tsc-transpile",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      const isTs = file.endsWith(".ts") || file.endsWith(".tsx");
      if (!isTs || file.endsWith(".d.ts") || file.includes("node_modules")) return null;
      const entry = join(TRANSPILE_CACHE, `${hash(file)}.json`);
      const source = hash(`${version}\n${code}`);
      try {
        const cached = JSON.parse(readFileSync(entry, "utf8")) as { source: string; code: string; map: unknown };
        if (cached.source === source) return { code: cached.code, map: cached.map as never };
      } catch {
        // not cached yet, or unreadable: compile it
      }
      const out = ts.transpileModule(code, { fileName: file, compilerOptions });
      const result = { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
      try {
        mkdirSync(TRANSPILE_CACHE, { recursive: true });
        writeFileSync(entry, JSON.stringify({ source, ...result }));
      } catch {
        // a read-only checkout still compiles, only without the cache
      }
      return result;
    },
  };
}

const TRANSPILE_CACHE = fileURLToPath(new URL("./node_modules/.cache/myco-tsc/", import.meta.url));
const TYPES_CACHE = fileURLToPath(new URL("./node_modules/.cache/myco-types.json", import.meta.url));
const hash = (text: string) => createHash("sha1").update(text).digest("hex");

/** The module the editor imports the engine's declarations from (ADR 0030). */
const ENGINE_TYPES = "virtual:myco-types";

/** The engine's Svelte renderer module (ADR 0419), which compiled UI components import as `myco/ui-renderer`. */
export const SVELTE_UI_RENDERER = fileURLToPath(new URL("./src/plugins/ui/svelte/renderer.ts", import.meta.url));

/** What compiled UI components get for `svelte/reactivity` (ADR 0418 wave 5): Svelte's with `MediaQuery` on the canvas. */
const SVELTE_UI_REACTIVITY = fileURLToPath(new URL("./src/plugins/ui/svelte/reactivity.ts", import.meta.url));
/** Svelte's `svelte/motion` entry, whose `prefersReducedMotion` is a `MediaQuery` from `svelte/reactivity` (ADR 0419 wave Z3). */
const SVELTE_MOTION_ENTRY = /[\\/]svelte[\\/]src[\\/]motion[\\/]index\.js$/;

/** ADR 0425: the inline HTML parser, which compiled components that use `{@html}` or `bind:innerHTML` import as `myco/ui-html`. */
export const SVELTE_UI_HTML = fileURLToPath(new URL("./src/plugins/ui/svelte/htmlInline.ts", import.meta.url));

/** The cascade's stylesheet parser, which Vitest's compiled components call when they load (ADR 0419). */
const UI_STYLESHEET_PARSER = fileURLToPath(new URL("./src/engine/ui/document/stylesheet.ts", import.meta.url));
/** The id prefix of a plain `.css` file a component imports, as a module registering its rules. */
const UI_CSS_PREFIX = "\0myco-ui-css:";

/**
 * Game UI components (ADR 0419): `*.svelte` compiled with the engine's custom renderer and external CSS,
 * `*.svelte.ts` rune modules, and plain `.css` files components import, through
 * `src/plugins/ui/svelte/compile.mjs`. Filenames are passed relative to the repository, so scoping hashes
 * don't depend on the checkout's location. Vitest uses it; the editor and the export compile the same way
 * through the project code linker (`projectCode/compileUI.ts`), which parses the CSS while compiling. Here,
 * in Node, the parser (TypeScript with decorators behind it) can't load while compiling, so the compiled
 * module calls it when it loads. The editor (dev server and build) uses it too, for the engine's built-in UI components
 * (ADR 0419 wave B, each plugin's `builtinUI.ts`), which it compiles with its shared runtime.
 */
export function svelteUI(options: { dev?: boolean } = {}): Plugin {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const styles = { parser: UI_STYLESHEET_PARSER };
  return {
    name: "myco:svelte-ui",
    enforce: "pre",
    async resolveId(source, importer) {
      // The renderer compiled components import (in every config that compiles them, aliased or not).
      if (source === "myco/ui-renderer") return SVELTE_UI_RENDERER;
      if (source === "myco/ui-html") return SVELTE_UI_HTML;
      // UI code's `svelte/reactivity` is Svelte's with `MediaQuery` on the canvas (ADR 0418 wave 5), as in the editor and games.
      // Svelte's own `svelte/motion` too, so its `prefersReducedMotion` follows the engine's setting (canvas `@media`) as UI code's `MediaQuery` does.
      if (source === "svelte/reactivity" && importer && (/\.svelte(\.[jt]s)?$/.test(importer.split("?")[0]) || SVELTE_MOTION_ENTRY.test(importer.split("?")[0]))) return SVELTE_UI_REACTIVITY;
      if (!importer || !source.endsWith(".css") || !/\.svelte(\.[jt]s)?$/.test(importer.split("?")[0])) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      return resolved ? UI_CSS_PREFIX + resolved.id : null;
    },
    async load(id) {
      if (!id.startsWith(UI_CSS_PREFIX)) return null;
      const file = id.slice(UI_CSS_PREFIX.length);
      const { compileSvelteUIStyles } = await import("./src/plugins/ui/svelte/compile.mjs");
      return compileSvelteUIStyles(readFileSync(file, "utf8"), { filename: relative(root, file).split(sep).join("/"), styles }).code;
    },
    async transform(code, id) {
      const file = id.split("?")[0];
      const isComponent = file.endsWith(".svelte");
      const isModule = file.endsWith(".svelte.ts") || file.endsWith(".svelte.js");
      // Only the repository's sources: a game build's compiled `code/ui/Hud.svelte.js` is already JavaScript.
      if ((!isComponent && !isModule) || !file.startsWith(root)) return null;
      const { compileSvelteUI, compileSvelteUIModule } = await import("./src/plugins/ui/svelte/compile.mjs");

      const filename = relative(root, file).split(sep).join("/");
      if (isComponent) {
        const r = compileSvelteUI(code, { filename, dev: options.dev, styles });
        for (const w of r.warnings) this.warn(`${w.code}: ${w.message}`);
        return { code: r.code, map: r.map as never };
      }
      const js = file.endsWith(".ts") ? ts.transpileModule(code, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false } }).outputText : code;
      const r = compileSvelteUIModule(js, { filename, dev: options.dev });
      return { code: r.code, map: r.map as never };
    },
  };
}

const REPO_ROOT = fileURLToPath(new URL(".", import.meta.url));

/** A TypeScript module a relative import names, as written or with `.ts`, `.tsx` or `/index.ts`. */
function tsModuleFile(base: string): string {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  throw new Error(`Can't find the module ${base}.`);
}

/**
 * What the engine's renderer, and the files beside it that it imports, import from the engine's own modules
 * (`ENGINE_SOURCE_DIR`): the value names by module file. Type-only imports are left out.
 */
function uiHostImports(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
    for (const st of source.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (!st.moduleSpecifier.text.startsWith(".")) continue;
      const target = tsModuleFile(join(dirname(file), st.moduleSpecifier.text));
      if (!relative(REPO_ROOT, target).split(sep).join("/").startsWith(ENGINE_SOURCE_DIR)) {
        visit(target);
        continue;
      }
      const names = out.get(target) ?? new Set<string>();
      out.set(target, names);
      if (ts.isExportDeclaration(st)) throw new Error(`${file}: the renderer can't re-export from the engine's modules (the player's UI host entry re-exports only what it imports).`);
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) throw new Error(`${file}: import the engine's modules by name (no default or namespace import), so the player's UI host entry can export them.`);
      for (const el of clause.namedBindings?.elements ?? []) if (!el.isTypeOnly) names.add((el.propertyName ?? el.name).text);
    }
  };
  visit(SVELTE_UI_RENDERER);
  return out;
}

/** The id of the player's UI host entry. */
const UI_HOST_ENTRY = "\0myco-ui-host";

/**
 * The player's UI host entry (ADR 0421), `myco-ui-host.js` beside myco.js: it re-exports what the engine's renderer
 * imports from the engine's own modules, by the names it imports (read from the renderer's source, so it follows
 * the renderer). A game's UI bundle carries the renderer with Svelte and imports these from it, so they're the
 * player's engine instance (Rollup shares the code with myco.js). Engine code only: the player has no Svelte.
 */
export function uiHostEntry(): { input: Record<string, string>; fileName: string; plugin: Plugin } {
  const name = UI_HOST_FILE.slice(0, -".js".length);
  return {
    input: { [name]: UI_HOST_ENTRY },
    fileName: UI_HOST_FILE,
    plugin: {
      name: "myco:ui-host-entry",
      resolveId: (id) => (id === UI_HOST_ENTRY ? id : null),
      load(id) {
        if (id !== UI_HOST_ENTRY) return null;
        const owner = new Map<string, string>();
        let code = "";
        for (const [file, names] of uiHostImports()) {
          this.addWatchFile(file);
          for (const n of names) {
            if (owner.has(n) && owner.get(n) !== file) throw new Error(`The renderer imports "${n}" from two engine modules (${owner.get(n)} and ${file}); the UI host entry needs one name per value.`);
            owner.set(n, file);
          }
          code += names.size > 0 ? `export { ${[...names].sort().join(", ")} } from ${JSON.stringify(file)};\n` : `import ${JSON.stringify(file)};\n`;
        }
        return code;
      },
    },
  };
}

/** The editor's copy of the engine's files a game's UI bundle reads (ADR 0421). */
const UI_RUNTIME_FILES = "virtual:myco-ui-runtime";

/**
 * The engine's files a game's UI bundle reads (ADR 0421: Svelte's client runtime, the renderer, the `package.json`
 * files resolving them reads), by path from the repository, as a virtual module, `virtual:myco-ui-runtime`. The
 * editor's exports bundle UI code from it (it can't read the engine's folder, which `npm run export` reads), loading
 * it on the first export with Svelte UI.
 */
export function uiRuntimeFiles(): Plugin {
  const resolved = `\0${UI_RUNTIME_FILES}`;
  return {
    name: "myco:ui-runtime-files",
    resolveId: (id) => (id === UI_RUNTIME_FILES ? resolved : null),
    async load(id) {
      if (id !== resolved) return null;
      const { collectUIRuntimeFiles } = await import("./src/projectCode/uiBundle");
      const files = await collectUIRuntimeFiles({
        read: async (path) => {
          const file = join(REPO_ROOT, ...path.split("/"));
          return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
        },
      });
      for (const path of files.keys()) this.addWatchFile(join(REPO_ROOT, ...path.split("/")));
      return `export default ${JSON.stringify(Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : 1))))};`;
    },
  };
}

/**
 * The engine's public type declarations as a virtual module
, `virtual:myco-types`: an
 * object of `.d.ts` text by path (`index.d.ts`, which re-exports `myco.d.ts`, the public module of
 * ADR 0135; `engine/core/World.d.ts`, `plugins/sky/runtime/index.d.ts`, ...), emitted in memory with
 * `tsconfig.engine.json`'s settings (internals stripped, editor access left out). The editor's
 * code editor serves them as the `"myco"` package (ADR 0030). Regenerated when an engine
 * source file changes.
 *
 * The editor SDK's declarations come with them (ADR 0139): `editor/sdk/index.d.ts` and the files it
 * reaches (only those), with `editor.d.ts` re-exporting it, so `"myco/editor"` resolves beside
 * `"myco"` for plugins' editor halves.
 */
export function engineTypes(): Plugin {
  const resolved = `\0${ENGINE_TYPES}`;
  return {
    name: "myco:engine-types",
    resolveId: (id) => (id === ENGINE_TYPES ? resolved : null),
    load(id) {
      if (id !== resolved) return null;
      const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL("./tsconfig.engine.json", import.meta.url)), {}, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        },
      });
      if (!config) throw new Error("tsconfig.engine.json: couldn't read it.");
      for (const f of config.fileNames) this.addWatchFile(f);
      const editorFiles = sourceFiles(EDITOR_DIR);
      for (const f of editorFiles) this.addWatchFile(f);
      // The emit takes several seconds and blocks the dev server meanwhile (the Code panel asks for
      // it once a project opens), so its output is kept on disk, reused while every engine source,
      // tsc and the options match (ADR 0082).
      const key = hash([ts.version, JSON.stringify(config.options), ...[...config.fileNames, ...editorFiles].map((f) => `${f}\n${readFileSync(f, "utf8")}`)].join("\0"));
      try {
        const cached = JSON.parse(readFileSync(TYPES_CACHE, "utf8")) as { key: string; code: string };
        if (cached.key === key) return cached.code;
      } catch {
        // not cached yet, or unreadable: emit it
      }
      const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true } });
      const outDir = config.options.outDir!.replace(/\\/g, "/");
      const files: Record<string, string> = {};
      program.emit(undefined, (fileName, text) => {
        const rel = fileName.replace(/\\/g, "/");
        files[rel.startsWith(`${outDir}/`) ? rel.slice(outDir.length + 1) : rel] = text;
      });
      // The public module is src/myco.ts (ADR 0135); the package's `index.d.ts` re-exports it.
      files["index.d.ts"] ??= 'export * from "./myco";\n';
      Object.assign(files, editorSdkDeclarations(program, config.options, outDir, files));
      files["editor.d.ts"] = 'export * from "./editor/sdk/index";\n';
      const code = `export default ${JSON.stringify(files)};`;
      try {
        mkdirSync(join(TYPES_CACHE, ".."), { recursive: true });
        writeFileSync(TYPES_CACHE, JSON.stringify({ key, code }));
      } catch {
        // a read-only checkout still works, only without the cache
      }
      return code;
    },
  };
}

const SRC_DIR = fileURLToPath(new URL("./src/", import.meta.url));
const EDITOR_DIR = join(SRC_DIR, "editor");

/** Every `.ts`/`.tsx` source under `dir` (tests left out). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * `myco/editor`'s declarations (ADR 0139): emitted one file at a time from `src/editor/sdk/index.ts`,
 * following the relative imports of each emitted `.d.ts`, so only what the SDK's types reach is kept.
 * Files `have` already holds (the engine's) aren't emitted again. Paths are relative to `src/`.
 */
function editorSdkDeclarations(engine: ts.Program, options: ts.CompilerOptions, outDir: string, have: Readonly<Record<string, string>>): Record<string, string> {
  const root = join(EDITOR_DIR, "sdk", "index.ts");
  const program = ts.createProgram({ rootNames: [root], options: { ...options, noEmit: false, declaration: true, emitDeclarationOnly: true }, oldProgram: engine });
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  const queue = [root];
  /** A source file for a `.d.ts` path relative to src/ ("editor/sdk/plugins.d.ts" → src/editor/sdk/plugins.ts or .tsx). */
  const sourceOf = (rel: string) => {
    const base = join(SRC_DIR, rel.replace(/\.d\.ts$/, ""));
    return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((f) => existsSync(f));
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = program.getSourceFile(file);
    if (!source) continue;
    program.emit(
      source,
      (fileName, text) => {
        const abs = fileName.replace(/\\/g, "/");
        const rel = abs.startsWith(`${outDir}/`) ? abs.slice(outDir.length + 1) : abs;
        if (!rel.endsWith(".d.ts") || rel in have) return;
        out[rel] = text;
        for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
          const target = join(dirname(rel), m[1]!).split(sep).join("/").replace(/\.js$/, "");
          if (`${target}.d.ts` in have || `${target}/index.d.ts` in have) continue;
          const next = sourceOf(`${target}.d.ts`);
          if (next) queue.push(next);
        }
      },
      undefined,
      true,
    );
  }
  return out;
}

/** A sample project (ADR 0031) as the editor's start screen lists it. */
export interface SampleInfo {
  /** Its folder name under samples/. */
  id: string;
  name: string;
  description?: string;
  /** Every file, project-relative, with its size in bytes. */
  files: { path: string; size: number }[];
}

const SAMPLES_DIR = fileURLToPath(new URL("./samples/", import.meta.url));
/** Left out of samples: hidden folders (the editor's .myco/), and the tsconfig.json the editor writes when a copy opens. sample.json is read for the list. */
const skipSampleFile = (path: string) => path.split("/").some((part) => part.startsWith(".") || part === "node_modules") || path === "tsconfig.json";

function sampleFiles(dir: string, root = dir): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const path = relative(root, full).split(sep).join("/");
    if (skipSampleFile(path)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...sampleFiles(full, root));
    else out.push({ path, size: stat.size });
  }
  return out;
}

/** Every folder under samples/ with a project.json. */
export function sampleManifest(): { samples: SampleInfo[] } {
  if (!existsSync(SAMPLES_DIR)) return { samples: [] };
  const samples: SampleInfo[] = [];
  for (const id of readdirSync(SAMPLES_DIR).sort()) {
    const dir = join(SAMPLES_DIR, id);
    if (!existsSync(join(dir, "project.json"))) continue;
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { name?: string };
    const extra = existsSync(join(dir, "sample.json")) ? (JSON.parse(readFileSync(join(dir, "sample.json"), "utf8")) as { name?: string; description?: string }) : {};
    samples.push({ id, name: extra.name ?? project.name ?? id, description: extra.description, files: sampleFiles(dir).filter((f) => f.path !== "sample.json") });
  }
  return { samples };
}

const SAMPLE_TYPES: Record<string, string> = { json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", obj: "model/obj", mtl: "model/mtl", fbx: "application/octet-stream", gltf: "model/gltf+json", glb: "model/gltf-binary", ktx2: "image/ktx2", hdr: "application/octet-stream", exr: "application/octet-stream", cube: "text/plain", env: "application/octet-stream", dds: "application/octet-stream", bin: "application/octet-stream", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };

/**
 * Ship the sample projects in samples/ beside the editor (ADR 0031), never inside it: the dev
 * server serves them at /samples/ as they are on disk (scripts as source text, not compiled), and
 * builds copy them to `samples/` in the output. `/samples/index.json` lists them (`sampleManifest`).
 */
export function samples(): Plugin {
  return {
    name: "myco:samples",
    configureServer(server) {
      // Before Vite's own middleware, which would compile the scripts.
      server.middlewares.use("/samples", (req, res, next) => {
        const url = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const manifest = sampleManifest();
        if (url === "index.json") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(manifest));
          return;
        }
        const [id, ...rest] = url.split("/");
        const path = rest.join("/");
        if (!manifest.samples.some((s) => s.id === id && s.files.some((f) => f.path === path))) return next();
        res.setHeader("Content-Type", SAMPLE_TYPES[path.split(".").pop()!.toLowerCase()] ?? "text/plain; charset=utf-8");
        res.end(readFileSync(join(SAMPLES_DIR, id, ...rest)));
      });
    },
    generateBundle() {
      const manifest = sampleManifest();
      this.emitFile({ type: "asset", fileName: "samples/index.json", source: JSON.stringify(manifest) });
      for (const sample of manifest.samples) {
        for (const file of sample.files) {
          this.emitFile({ type: "asset", fileName: `samples/${sample.id}/${file.path}`, source: readFileSync(join(SAMPLES_DIR, sample.id, file.path)) });
        }
      }
    },
  };
}

/** The prebuilt game player (ADR 0041), built by vite.player.config.ts. */
const PLAYER_DIR = fileURLToPath(new URL("./dist/player/", import.meta.url));

/**
 * Player build: list every output file in `files.json`, for the exporters to copy (ADR 0041). With `debug` (the debug
 * link's modules, ADR 0376), `files.json` also lists as `debug` the chunks only the link reaches: the chunks holding one
 * of those modules and every chunk reached only through them. A release export leaves those out, so it holds none of
 * the link's code. The build fails when an entry needs one of them without `import()` (statically, through any chunk).
 */
export function playerFileList(options: { debug?: LazyOnlyRule } = {}): Plugin {
  return {
    name: "myco:player-files",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).sort();
      const list: { files: string[]; debug?: string[] } = { files };
      if (options.debug) {
        const { debug, problems } = debugOnlyChunks(bundle, options.debug);
        if (problems.length > 0) this.error(`Debug link code is in what every build ships:\n${problems.join("\n")}`);
        list.debug = debug;
      }
      this.emitFile({ type: "asset", fileName: "files.json", source: `${JSON.stringify(list, null, 2)}\n` });
    },
  };
}

/** The chunks of `bundle` only `rule`'s modules lead to (sorted), and what puts one of them in every build. */
function debugOnlyChunks(bundle: Rollup.OutputBundle, rule: LazyOnlyRule): { debug: string[]; problems: string[] } {
  const chunks = new Map<string, Rollup.OutputChunk>();
  for (const out of Object.values(bundle)) if (out.type === "chunk") chunks.set(out.fileName, out);
  const holds = (c: Rollup.OutputChunk) => c.moduleIds.some((raw) => rule.matches(raw.replaceAll("\\", "/")));
  const roots = new Set([...chunks.values()].filter(holds).map((c) => c.fileName));
  const problems: string[] = [];
  // Everything an entry reaches without entering a root: what every build ships.
  const shipped = new Set<string>();
  const walk = (file: string, from: string) => {
    if (shipped.has(file)) return;
    const chunk = chunks.get(file);
    if (!chunk) return;
    shipped.add(file);
    for (const next of chunk.imports) {
      if (roots.has(next)) problems.push(`${file} statically imports ${next} (the entry ${from} loads it): ${rule.why}`);
      else walk(next, from);
    }
    for (const next of chunk.dynamicImports) if (!roots.has(next)) walk(next, from);
  };
  for (const c of chunks.values()) {
    if (!c.isEntry) continue;
    if (roots.has(c.fileName)) problems.push(`the entry ${c.fileName} holds debug link modules: ${rule.why}`);
    else walk(c.fileName, c.fileName);
  }
  const debug = new Set<string>();
  const reach = (file: string) => {
    if (debug.has(file) || shipped.has(file) || !chunks.has(file)) return;
    debug.add(file);
    const chunk = chunks.get(file)!;
    for (const next of [...chunk.imports, ...chunk.dynamicImports]) reach(next);
  };
  for (const r of roots) reach(r);
  return { debug: [...debug].sort(), problems };
}

/** Source modules a build must only load on demand (by `import()`), and why. */
export interface LazyOnlyRule {
  /** Whether a module id (an absolute source path, `/` separated) is one of them. */
  readonly matches: (id: string) => boolean;
  /** Why they must stay lazy, for the build error. */
  readonly why: string;
}

/**
 * Fail the build when an entry chunk's static imports reach a module one of `rules` names: code that should load on
 * demand (ADR 0230: the audio capture codec, which once leaked into the player's main chunk unnoticed). It reads the
 * bundle's chunks and the source modules in each, so it doesn't depend on how chunks are named or split.
 */
export function lazyOnly(rules: readonly LazyOnlyRule[]): Plugin {
  return {
    name: "myco:lazy-only",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const chunks = new Map<string, Rollup.OutputChunk>();
      for (const out of Object.values(bundle)) if (out.type === "chunk") chunks.set(out.fileName, out);
      const problems: string[] = [];
      for (const entry of chunks.values()) {
        if (!entry.isEntry) continue;
        const seen = new Set<string>();
        const walk = (file: string) => {
          const chunk = chunks.get(file);
          if (!chunk || seen.has(file)) return;
          seen.add(file);
          for (const raw of chunk.moduleIds) {
            const id = raw.replaceAll("\\", "/");
            for (const rule of rules) if (rule.matches(id)) problems.push(`${entry.fileName} statically imports ${id} (in ${chunk.fileName}): ${rule.why}`);
          }
          for (const next of chunk.imports) walk(next);
        };
        walk(entry.fileName);
      }
      if (problems.length > 0) this.error(`Code that must load on demand is in an entry's static imports:\n${problems.join("\n")}`);
    },
  };
}

/**
 * The audio capture codec (ADR 0171, 0172, 0230): everything in `capture/` but the service a game always has
 * (`capture.ts`, and ADR 0348's take service beside it: `take.ts`, the request tap `takeTap.ts`, the generator seam
 * `takeSeed.ts` and the mix-op origin `mixOpOrigin.ts`, all small and without the codec) and the keyframe row layout the
 * writers share (`keyframeLayout.ts`). The player loads it on the first `Audio.capture.start()` or take.
 */
export const CAPTURE_CODEC: LazyOnlyRule = {
  matches: (id) => /\/src\/plugins\/audio\/runtime\/capture\/(?!(?:capture|keyframeLayout|take|takeTap|takeSeed|mixOpOrigin)\.ts$)[^/]+\.ts$/.test(id),
  why: "the audio capture codec loads with Audio.capture.start(), by import() (ADR 0230)",
};

/**
 * The debug link (ADR 0376, 0403): everything under `src/engine/debugLink/` (subfolders too: pairing, rendezvous, the
 * listener transport) but the topic registry plugins register through (`topics.ts`, a map of `import()` functions with
 * type-only imports); the `webrtc` transport only the link uses (`src/engine/net/transport/webrtc.ts`); the player's
 * pairing overlay (`src/player/debugOverlay*.ts`); and the plugins' topics (`runtime/**\/debugLink/`). The player loads
 * them by `import()` when `game.json` has `debug`; release exports leave their chunks out.
 */
export const DEBUG_LINK: LazyOnlyRule = {
  matches: (id) =>
    /\/src\/engine\/debugLink\/(?!topics\.ts$)(?:[^/]+\/)*[^/]+\.ts$/.test(id) ||
    /\/src\/engine\/net\/transport\/webrtc\.ts$/.test(id) ||
    /\/src\/player\/debugOverlay[^/]*\.ts$/.test(id) ||
    /\/src\/plugins\/[^/]+\/runtime\/(?:[^/]+\/)*debugLink\/[^/]+\.ts$/.test(id),
  why: "the debug link loads only in builds with debugging on, by import() (ADR 0376)",
};

/** The player's files as `dist/player/files.json` lists them, or null if the player isn't built. */
export function playerManifest(): { files: string[] } | null {
  const list = join(PLAYER_DIR, "files.json");
  return existsSync(list) ? (JSON.parse(readFileSync(list, "utf8")) as { files: string[] }) : null;
}

/**
 * Ship the prebuilt player beside the editor (ADR 0041), as samples are: the dev server serves
 * dist/player/ at /player/ (once `npm run build:player` has run), and the editor build copies it
 * to `player/`, so the editor's Export can fetch the player files and write them into a build.
 */
export function playerFiles(): Plugin {
  return {
    name: "myco:player",
    configureServer(server) {
      server.middlewares.use("/player", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
        const manifest = playerManifest();
        if (!manifest || !(path === "files.json" || manifest.files.includes(path))) return next();
        const ext = path.split(".").pop()!.toLowerCase();
        res.setHeader("Content-Type", ext === "js" ? "text/javascript" : ext === "html" ? "text/html" : (SAMPLE_TYPES[ext] ?? "application/octet-stream"));
        res.end(readFileSync(join(PLAYER_DIR, ...path.split("/"))));
      });
    },
    generateBundle() {
      const manifest = playerManifest();
      if (!manifest) {
        this.warn("dist/player/ isn't built, so the editor build has no player to export games with. Run `npm run build:player` first.");
        return;
      }
      this.emitFile({ type: "asset", fileName: "player/files.json", source: readFileSync(join(PLAYER_DIR, "files.json")) });
      for (const file of manifest.files) this.emitFile({ type: "asset", fileName: `player/${file}`, source: readFileSync(join(PLAYER_DIR, ...file.split("/"))) });
    },
  };
}

/**
 * Ship the rendezvous bundle beside the editor (ADR 0403, plan R4), as the player is: the dev server serves
 * dist/rendezvous/rendezvous.mjs at /rendezvous/rendezvous.mjs (once `npm run build:rendezvous` has run), and the editor
 * build copies it to `rendezvous/`, so the editor's Export can write it beside a debug web build's `serve.mjs`.
 */
export function rendezvousFile(): Plugin {
  const file = fileURLToPath(new URL("./dist/rendezvous/rendezvous.mjs", import.meta.url));
  return {
    name: "myco:rendezvous-file",
    configureServer(server) {
      server.middlewares.use("/rendezvous/rendezvous.mjs", (_req, res, next) => {
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", "text/javascript");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      if (!existsSync(file)) {
        this.warn("dist/rendezvous/ isn't built, so the editor's debug web exports get no rendezvous. Run `npm run build:rendezvous` first.");
        return;
      }
      this.emitFile({ type: "asset", fileName: "rendezvous/rendezvous.mjs", source: readFileSync(file) });
    },
  };
}

/** `"myco"` (and its old name) as project scripts and samples import the engine (ADR 0031): the engine's public module. */
export const MYCO_ALIASES: Record<string, string> = {
  // Before "myco", which would otherwise take it as a path inside the engine's module.
  "myco/ui-renderer": SVELTE_UI_RENDERER,
  "myco/ui-html": SVELTE_UI_HTML,
  myco: fileURLToPath(new URL("./src/myco.ts", import.meta.url)),
  tranquility: fileURLToPath(new URL("./src/myco.ts", import.meta.url)),
};

/**
 * Folders the dev servers (`npm run dev`, Storybook) never watch. Vite's watcher walks everything under the root that
 * isn't ignored as the server starts, competing with the dependency optimizer for the disk and the event loop, so big
 * trees of non-source files kept start-up on "optimizing dependencies" for minutes: Rust build output (`src-tauri/target`,
 * the standalone Audio Studio's `src-studio-tauri/target` (ADR 0341) and the crates' `target` folders under `native/`,
 * hundreds of thousands of files once built) and agent worktrees in
 * `.claude/worktrees/`, each a full checkout with its own build output. Vite already skips `.git`, `node_modules`,
 * `test-results` and the build's outDir.
 */
export const UNWATCHED = ["**/src-tauri/**", "**/src-studio-tauri/**", "**/target/**", "**/.claude/**", "**/playwright-report/**"];

/**
 * The editor's Vite settings for rendering its components outside the editor page (ADR 0219): Storybook's build and
 * the story tests. tsc compiles TypeScript and JSX as in the editor (`oxc` off), workers are ES modules with the same
 * transpile, the engine's declarations and the `"myco"` alias resolve, and Preact's JSX runtime is pre-bundled (the
 * dependency scanner never sees the import tsc adds).
 */
export function componentViteConfig(): UserConfig {
  return {
    plugins: [typescriptTranspile(), engineTypes()],
    server: { watch: { ignored: UNWATCHED } },
    worker: { format: "es", plugins: () => [typescriptTranspile()] },
    oxc: false,
    resolve: { alias: MYCO_ALIASES },
    optimizeDeps: { include: ["preact/jsx-runtime"] },
  };
}
