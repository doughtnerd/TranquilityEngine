// Monaco for the Code panel (ADR 0030), loaded the first time the panel shows. Sets up its
// workers, a TypeScript service that knows the engine's types as the `"myco"` package,
// the editor's colours (from the editor theme, theme.ts), and one model per project script (so
// autocomplete and errors work across scripts).
import { effect } from "@preact/signals";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import engineTypes from "virtual:myco-types";
import { codeLanguageOf } from "../projectPaths";
import { codeAppearance, monacoColors } from "../theme";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  // Each language service runs in its own worker; everything else in the editor's.
  getWorker: (_id, label) =>
    label === "typescript" || label === "javascript" ? new TsWorker() : label === "json" ? new JsonWorker() : label === "css" ? new CssWorker() : new EditorWorker(), // UI stylesheets (ADR 0077); XML needs no worker
};

const ts = monaco.typescript;
ts.typescriptDefaults.setCompilerOptions({
  target: 9 as monaco.typescript.ScriptTarget, // ES2022, as scripts are compiled (Monaco's enum stops at ES2020)
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,
  lib: ["es2022", "dom"],
  strict: true,
  noEmit: true,
  useDefineForClassFields: true,
  allowNonTsExtensions: true,
  resolveJsonModule: true,
});
// Every script model, not only the one showing, so imports between scripts resolve.
ts.typescriptDefaults.setEagerModelSync(true);
// The engine's declarations, served as the package scripts import.
for (const [path, text] of Object.entries(engineTypes)) ts.typescriptDefaults.addExtraLib(text, `file:///node_modules/myco/${path}`);
ts.typescriptDefaults.addExtraLib(JSON.stringify({ name: "myco", types: "index.d.ts" }), "file:///node_modules/myco/package.json");
// Scripts written before the rename import "tranquility" (ADR 0037): the same declarations.
ts.typescriptDefaults.addExtraLib('export * from "myco";', "file:///node_modules/tranquility/index.d.ts");

// The "myco" theme follows Settings > Appearance: redefined from the editor theme's tokens on change.
effect(() => {
  const { kind, tokens } = codeAppearance.value;
  monaco.editor.defineTheme("myco", {
    base: kind === "light" ? "vs" : kind === "high-contrast" ? "hc-black" : "vs-dark",
    inherit: true,
    rules: [],
    colors: monacoColors(tokens),
  });
  monaco.editor.setTheme("myco");
});

export { monaco };

const uriOf = (path: string) => monaco.Uri.parse(`file:///project/${path}`);

/** The model for a project file (a script, JSON, a JavaScript or TypeScript module, Markdown or text), made if needed. */
export function modelFor(path: string, text: string): monaco.editor.ITextModel {
  return monaco.editor.getModel(uriOf(path)) ?? monaco.editor.createModel(text, codeLanguageOf(path), uriOf(path));
}

/**
 * Bring the file models in line with `scripts` (project path → text on disk, every file the Code
 * panel can show): new files get models, models of deleted files go, and models without unsaved
 * edits take the text on disk. `dirty` are paths with unsaved edits, left alone. JSON files are
 * also given to the TypeScript service, so scripts can import them with their types.
 */
export function syncModels(scripts: ReadonlyMap<string, string>, dirty: ReadonlySet<string>): void {
  for (const model of monaco.editor.getModels()) {
    const path = model.uri.path.replace(/^\/project\//, "");
    if (model.uri.scheme !== "file" || !model.uri.path.startsWith("/project/")) continue;
    if (!scripts.has(path) && !dirty.has(path)) model.dispose();
  }
  for (const [path, text] of scripts) {
    const model = modelFor(path, text);
    if (!dirty.has(path) && model.getValue() !== text) model.setValue(text);
  }
  syncJsonLibs(scripts);
}

/** JSON files the TypeScript service has, by path, with their text. */
const jsonLibs = new Map<string, { text: string; lib: monaco.IDisposable }>();

/** Give the TypeScript service the project's JSON files (it only reads TS and JS models), so `import x from "./a.json"` resolves with types. */
function syncJsonLibs(files: ReadonlyMap<string, string>): void {
  for (const [path, entry] of jsonLibs) {
    if (files.get(path) === entry.text) continue;
    entry.lib.dispose();
    jsonLibs.delete(path);
  }
  for (const [path, text] of files) {
    if (!path.endsWith(".json") || jsonLibs.has(path)) continue;
    // Monaco's worker reads files with unknown extensions, .json included, as TypeScript, so give it
    // the JSON as a module whose default export has the types TypeScript infers from it.
    let module = "declare const json: any;\nexport default json;\n";
    try {
      JSON.parse(text);
      module = `const json = ${text.trim()};\nexport default json;\n`;
    } catch {
      // invalid JSON: untyped (the loader reports it when a script imports it)
    }
    jsonLibs.set(path, { text, lib: ts.typescriptDefaults.addExtraLib(module, `file:///project/${path}`) });
  }
}

/** The project whose files the models hold. */
let modelsProject: unknown = null;

/**
 * Bring the models in line with `project`'s files (see syncModels). When another project opened,
 * the last one's models and JSON go first.
 */
export function syncProject(project: unknown, files: ReadonlyMap<string, string>, dirty: ReadonlySet<string>): void {
  if (modelsProject !== project) {
    disposeModels();
    modelsProject = project;
  }
  syncModels(files, dirty);
}

/**
 * Get ready to open `project`'s files without a wait: make the models and start the TypeScript
 * worker, which parses the engine's declarations and the scripts on its first request.
 */
export async function warmUp(project: unknown, files: ReadonlyMap<string, string>): Promise<void> {
  syncProject(project, files, new Set());
  const script = [...files.keys()].find((p) => p.endsWith(".ts"));
  if (!script) return;
  const worker = await ts.getTypeScriptWorker();
  const client = await worker(uriOf(script));
  await client.getSemanticDiagnostics(uriOf(script).toString());
}

/** Drop every file model (another project opened). */
function disposeModels(): void {
  for (const model of monaco.editor.getModels()) if (model.uri.path.startsWith("/project/")) model.dispose();
  for (const entry of jsonLibs.values()) entry.lib.dispose();
  jsonLibs.clear();
}

/** The declaration files of the project's npm packages the TypeScript service has (ADR 0125), by path. */
const packageLibs = new Map<string, { text: string; lib: monaco.IDisposable }>();

/**
 * Give the TypeScript service the project's npm package declarations (ADR 0125): `files` by
 * project path (`node_modules/…`, from `packageTypes`), served at `file:///node_modules/…` as the
 * engine's are, and an untyped module for each package in `untyped`.
 */
export function setPackageTypes(files: ReadonlyMap<string, string>, untyped: readonly string[]): void {
  const wanted = new Map(files);
  for (const name of untyped) wanted.set(`node_modules/.myco-untyped/${name}.d.ts`, `declare module ${JSON.stringify(name)};\n`);
  for (const [path, entry] of packageLibs) {
    if (wanted.get(path) === entry.text) continue;
    entry.lib.dispose();
    packageLibs.delete(path);
  }
  for (const [path, text] of wanted) {
    if (packageLibs.has(path)) continue;
    packageLibs.set(path, { text, lib: ts.typescriptDefaults.addExtraLib(text, `file:///${path}`) });
  }
}

/** A type error in a script (ADR 0125): 1-based line and column. */
export interface ScriptDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const flatten = (text: string | { messageText: string; next?: unknown[] }): string =>
  typeof text === "string" ? text : [text.messageText, ...((text.next ?? []) as (typeof text)[]).map(flatten)].join(" ");

/**
 * Type-check `project`'s scripts (paths in `files` under scripts/) with the TypeScript service, as
 * the Code panel shows them: their syntax and type errors (not warnings or suggestions), in path
 * then line order.
 */
export async function checkScripts(project: unknown, files: ReadonlyMap<string, string>, dirty: ReadonlySet<string>): Promise<ScriptDiagnostic[]> {
  syncProject(project, files, dirty);
  const scripts = [...files.keys()].filter((p) => p.startsWith("scripts/") && p.endsWith(".ts") && !p.endsWith(".d.ts")).sort();
  if (scripts.length === 0) return [];
  const worker = await ts.getTypeScriptWorker();
  const client = await worker(...scripts.map(uriOf));
  const out: ScriptDiagnostic[] = [];
  for (const path of scripts) {
    const uri = uriOf(path).toString();
    const model = monaco.editor.getModel(uriOf(path));
    const found = [...(await client.getSyntacticDiagnostics(uri)), ...(await client.getSemanticDiagnostics(uri))];
    for (const d of found) {
      if (d.category !== 1) continue; // errors only
      const at = model && d.start !== undefined ? model.getPositionAt(d.start) : null;
      out.push({ path, line: at?.lineNumber ?? 1, column: at?.column ?? 1, message: flatten(d.messageText as never) });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
