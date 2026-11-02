// Monaco for the Code panel (ADR 0030), loaded the first time the panel shows. Sets up its
// workers, a TypeScript service that knows the engine's types as the `"tranquility"` package,
// the editor's colours, and one model per project script (so autocomplete and errors work
// across scripts).
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import engineTypes from "virtual:tranquility-types";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  // Each language service runs in its own worker; everything else in the editor's.
  getWorker: (_id, label) => (label === "typescript" || label === "javascript" ? new TsWorker() : label === "json" ? new JsonWorker() : new EditorWorker()),
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
for (const [path, text] of Object.entries(engineTypes)) ts.typescriptDefaults.addExtraLib(text, `file:///node_modules/tranquility/${path}`);
ts.typescriptDefaults.addExtraLib(JSON.stringify({ name: "tranquility", types: "index.d.ts" }), "file:///node_modules/tranquility/package.json");

monaco.editor.defineTheme("tranquility", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1b1d21",
    "editor.lineHighlightBackground": "#23262c",
    "editorLineNumber.foreground": "#5a5f68",
    "editorGutter.background": "#1b1d21",
    "editorWidget.background": "#212329",
    "editorWidget.border": "#2c3036",
    "editor.selectionBackground": "#2d4166",
    focusBorder: "#4c8dff",
  },
});

export { monaco };

const uriOf = (path: string) => monaco.Uri.parse(`file:///project/${path}`);

/** Monaco's language for a project file, by extension. */
const languageOf = (path: string) => (path.endsWith(".json") ? "json" : path.endsWith(".js") ? "javascript" : "typescript");

/** The model for a project file (script, JSON or JavaScript), made if needed. */
export function modelFor(path: string, text: string): monaco.editor.ITextModel {
  return monaco.editor.getModel(uriOf(path)) ?? monaco.editor.createModel(text, languageOf(path), uriOf(path));
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
