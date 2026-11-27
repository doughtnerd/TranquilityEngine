// Monaco for the Code panel (ADR 0030), loaded the first time the panel shows. Sets up its
// workers, a TypeScript service that knows the engine's types as the `"myco"` package,
// the editor's colours (from the editor theme, theme.ts), and one model per project script (so
// autocomplete and errors work across scripts). The models are an adapter of the Code buffers
// (codeBuffers.ts, ADR 0308): each holds its buffer's text, unsaved or the file's.
import { effect } from "@preact/signals";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker.js?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker.js?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker.js?worker";
import engineTypes from "virtual:myco-types";
import { codeLanguageOf, isScriptPath } from "../projectPaths";
import { codeFilePath, codeFileUri } from "./codeBuffers";
import { codeAppearance, monacoColors } from "../theme";
import { compilerOptions, SCRIPT_CHECK } from "../../scriptCompiler.mjs";
import { isRuneModulePath, isSvelteComponentPath } from "../../projectCode/uiModules";
import { componentTypeScript, generatedPathOf, inComponentCode, SVELTE_CHECK_TYPES, type ComponentRange, type ComponentTypeScript } from "./svelteCheck";


(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  // Each language service runs in its own worker; everything else in the editor's.
  // CSS for UI stylesheets (ADR 0077), HTML for Svelte components (which edit as HTML, projectPaths.ts); XML needs no worker.
  getWorker: (_id, label) =>
    label === "typescript" || label === "javascript" ? new TsWorker() : label === "json" ? new JsonWorker() : label === "css" ? new CssWorker() : label === "html" ? new HtmlWorker() : new EditorWorker(),
};

const ts = monaco.typescript;
// Scripts are checked as every host compiles and resolves them (ADR 0332), as an external editor
// checks them with the project's tsconfig.json.
ts.typescriptDefaults.setCompilerOptions({ ...compilerOptions(SCRIPT_CHECK), noEmit: true, allowNonTsExtensions: true });
// Every script model, not only the one showing, so imports between scripts resolve.
ts.typescriptDefaults.setEagerModelSync(true);
// The engine's declarations, served as the package scripts import.
for (const [path, text] of Object.entries(engineTypes)) ts.typescriptDefaults.addExtraLib(text, `file:///node_modules/myco/${path}`);
ts.typescriptDefaults.addExtraLib(JSON.stringify({ name: "myco", types: "index.d.ts" }), "file:///node_modules/myco/package.json");
// Scripts written before the rename import "tranquility" (ADR 0037): the same declarations.
ts.typescriptDefaults.addExtraLib('export * from "myco";', "file:///node_modules/tranquility/index.d.ts");
// Svelte UI (ADR 0423): Svelte's declarations (its modules and the runes rune modules use), served as the package, with
// what components' TypeScript needs (ADR 0432, svelteCheck.ts); Svelte's own `*.svelte` module types a component the
// service has no TypeScript for yet.
for (const [path, text] of SVELTE_CHECK_TYPES) ts.typescriptDefaults.addExtraLib(text, `file:///${path}`);


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

const uriOf = (path: string) => monaco.Uri.parse(codeFileUri(path));

/** The model for a project file (a script, JSON, a JavaScript or TypeScript module, Markdown or text), made if needed. */
export function modelFor(path: string, text: string): monaco.editor.ITextModel {
  return monaco.editor.getModel(uriOf(path)) ?? monaco.editor.createModel(text, codeLanguageOf(path), uriOf(path));
}

/**
 * Make the file models hold `buffers` (project path → the buffer's text, every file the Code panel
 * can show, `bufferTexts`): new files get models, models of files that are gone go, and the others
 * take their buffer's text. JSON files are also given to the TypeScript service, so scripts can
 * import them with their types.
 */
function syncModels(buffers: ReadonlyMap<string, string>): void {
  for (const model of monaco.editor.getModels()) {
    const path = codeFilePath(model.uri);
    if (path !== null && !buffers.has(path)) model.dispose();
  }
  for (const [path, text] of buffers) {
    const model = modelFor(path, text);
    if (model.getValue() !== text) model.setValue(text);
  }
  syncJsonLibs(buffers);
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
    jsonLibs.set(path, { text, lib: ts.typescriptDefaults.addExtraLib(module, codeFileUri(path)) });
  }
}

/** The project whose files the models hold. */
let modelsProject: unknown = null;

/**
 * Bring the models in line with `project`'s files (see syncModels). When another project opened,
 * the last one's models and JSON go first.
 */
export function syncProject(project: unknown, buffers: ReadonlyMap<string, string>): void {
  if (modelsProject !== project) {
    disposeModels();
    modelsProject = project;
  }
  syncModels(buffers);
}

/**
 * Get ready to open `project`'s files without a wait: make the models and start the TypeScript
 * worker, which parses the engine's declarations and the scripts on its first request.
 */
export async function warmUp(project: unknown, files: ReadonlyMap<string, string>): Promise<void> {
  syncProject(project, files);
  const script = [...files.keys()].find((p) => p.endsWith(".ts"));
  if (!script) return;
  const worker = await ts.getTypeScriptWorker();
  const client = await worker(uriOf(script));
  await client.getSemanticDiagnostics(uriOf(script).toString());
}

/** Drop every file model (another project opened). */
function disposeModels(): void {
  for (const model of monaco.editor.getModels()) if (codeFilePath(model.uri) !== null) model.dispose();
  for (const entry of jsonLibs.values()) entry.lib.dispose();
  jsonLibs.clear();
  for (const entry of componentLibs.values()) entry.lib.dispose();
  componentLibs.clear();
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

/** A type error in a script (ADR 0125), or in a Svelte component (ADR 0432): 1-based line and column. */
export interface ScriptDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

const flatten = (text: string | { messageText: string; next?: unknown[] }): string =>
  typeof text === "string" ? text : [text.messageText, ...((text.next ?? []) as (typeof text)[]).map(flatten)].join(" ");

// ---------------------------------------------------------------------------------------------
// Svelte components' TypeScript (ADR 0432)

/** A component's TypeScript the TypeScript service has: made from `source`, served at its `generated` path. */
interface ComponentLib {
  readonly source: string;
  readonly check: ComponentTypeScript;
  readonly lib: monaco.IDisposable;
}

/** The components' TypeScript the service has, by component path. */
const componentLibs = new Map<string, ComponentLib>();
/** The last sync of the components' TypeScript (syncs run one at a time). */
let componentSync: Promise<void> = Promise.resolve();

/** The components the file models hold, by project path, with their text (unsaved edits included). */
function componentTexts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const model of monaco.editor.getModels()) {
    const path = codeFilePath(model.uri);
    if (path !== null && isSvelteComponentPath(path)) out.set(path, model.getValue());
  }
  return out;
}

/**
 * Give the service the TypeScript of the components the models hold (svelte2tsx), made again for those whose text
 * changed, and drop gone components'. An import of a component resolves to its TypeScript, so scripts and rune
 * modules see its props.
 */
function syncComponents(): Promise<void> {
  const run = componentSync.then(async () => {
    const texts = componentTexts();
    let changed = false;
    for (const [path, entry] of componentLibs) {
      if (texts.has(path)) continue;
      entry.lib.dispose();
      componentLibs.delete(path);
      changed = true;
    }
    // A rune module with the generated name keeps it (generatedPathOf).
    const taken = (path: string) => monaco.editor.getModel(uriOf(path)) !== null;
    for (const [path, text] of texts) {
      const generated = generatedPathOf(path, taken);
      const entry = componentLibs.get(path);
      if (entry && entry.source === text && entry.check.generated === generated) continue;
      const check = await componentTypeScript(path, text, generated);
      // Adding a library at a path the service has replaces it (the old one's dispose then does nothing).
      const lib = ts.typescriptDefaults.addExtraLib(check.code, codeFileUri(generated));
      if (entry && entry.check.generated !== generated) entry.lib.dispose();
      componentLibs.set(path, { source: text, check, lib });
      changed = true;
    }
    // Monaco hands the worker its libraries a task after they change: ask it nothing before then.
    if (changed) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  componentSync = run.catch(() => {});
  return run;
}

/** A type error in a component, at its span (ADR 0432). */
type ComponentError = ComponentRange & { readonly path: string; readonly message: string };

/**
 * The type errors of the components the models hold: the errors (not warnings or suggestions) in their TypeScript
 * that map back into them, and their syntax errors. JavaScript components aren't checked (as svelte-check).
 */
async function componentErrors(): Promise<ComponentError[]> {
  await syncComponents();
  const checks = [...componentLibs.values()].map((e) => e.check);
  if (checks.length === 0) return [];
  const worker = await ts.getTypeScriptWorker();
  const client = await worker();
  const out: ComponentError[] = [];
  for (const check of checks) {
    if (check.error) out.push({ path: check.path, ...check.error });
    if (!check.checked) continue;
    const uri = codeFileUri(check.generated);
    const found = [...(await client.getSyntacticDiagnostics(uri)), ...(await client.getSemanticDiagnostics(uri))];
    for (const d of found) {
      if (d.category !== 1) continue; // errors only
      const range = check.sourceRange(d.start ?? 0, d.length ?? 0);
      if (range) out.push({ path: check.path, ...range, message: flatten(d.messageText as never) });
    }
  }
  return out;
}

/** The owner of the component markers (Monaco's own TypeScript markers don't cover HTML models). */
const COMPONENT_MARKERS = "svelte-typescript";
let markersTimer: ReturnType<typeof setTimeout> | undefined;

/** Show the components' type errors as their models' markers (the Code panel's squiggles), once edits pause. */
function scheduleComponentMarkers(): void {
  clearTimeout(markersTimer);
  markersTimer = setTimeout(() => {
    showComponentMarkers().catch((err: unknown) => console.warn("[editor] couldn't type-check the Svelte components:", err));
  }, 400);
}

async function showComponentMarkers(): Promise<void> {
  if (componentTexts().size === 0 && componentLibs.size === 0) return;
  const byPath = new Map<string, ComponentError[]>();
  for (const e of await componentErrors()) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  for (const model of monaco.editor.getModels()) {
    const path = codeFilePath(model.uri);
    if (path === null || !isSvelteComponentPath(path)) continue;
    monaco.editor.setModelMarkers(
      model,
      COMPONENT_MARKERS,
      (byPath.get(path) ?? []).map((e) => ({
        severity: monaco.MarkerSeverity.Error,
        message: e.message,
        source: "ts",
        startLineNumber: e.line,
        startColumn: e.column,
        endLineNumber: e.endLine,
        endColumn: e.endColumn,
      })),
    );
  }
}

// Any project file's edit can change a component's errors (its own text, a script or rune module it imports, or a
// component importing it), as can a file coming or going.
monaco.editor.onDidCreateModel((model) => {
  if (codeFilePath(model.uri) === null) return;
  const edits = model.onDidChangeContent(scheduleComponentMarkers);
  model.onWillDispose(() => {
    edits.dispose();
    scheduleComponentMarkers();
  });
  scheduleComponentMarkers();
});

// ---------------------------------------------------------------------------------------------
// Hover, completion, signature help and go to definition in Svelte components (ADR 0432)
//
// Components edit as HTML, which Monaco's TypeScript features don't serve: these ask the TypeScript service about the
// component's TypeScript at the caret's place in it (`generatedOffset`), and map what comes back to the component.

/** Where the caret in a component's model is in its TypeScript: the service's file and offset, with the component's TypeScript. */
async function componentPlace(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<{ check: ComponentTypeScript; uri: string; offset: number } | null> {
  const path = codeFilePath(model.uri);
  if (path === null || !isSvelteComponentPath(path)) return null;
  await syncComponents();
  const check = componentLibs.get(path)?.check;
  if (!check) return null;
  const offset = check.generatedOffset(position.lineNumber, position.column);
  return offset === null ? null : { check, uri: codeFileUri(check.generated), offset };
}

async function tsClient() {
  return (await ts.getTypeScriptWorker())();
}

type DisplayPart = { text: string };
const partsText = (parts: readonly DisplayPart[] | undefined): string => (parts ?? []).map((p) => p.text).join("");

/** A span of a component's TypeScript as a range of the component, or undefined where it maps to none. */
function componentRange(check: ComponentTypeScript, span: { start: number; length: number } | undefined): monaco.IRange | undefined {
  const r = span && check.sourceRange(span.start, span.length);
  return r ? { startLineNumber: r.line, startColumn: r.column, endLineNumber: r.endLine, endColumn: r.endColumn } : undefined;
}

/** svelte2tsx's own declarations, which completion leaves out. */
const isGeneratedName = (name: string) => name.startsWith("__sveltets") || name.startsWith("$$") || name === "svelteHTML" || name.endsWith("__SvelteComponent_");

const Kind = monaco.languages.CompletionItemKind;
/** TypeScript's element kinds as Monaco's completion kinds (as Monaco's own TypeScript completion maps them). */
const COMPLETION_KINDS: Readonly<Record<string, monaco.languages.CompletionItemKind>> = {
  keyword: Kind.Keyword, "primitive type": Kind.Keyword, module: Kind.Module, "external module name": Kind.Module, class: Kind.Class,
  "local class": Kind.Class, interface: Kind.Interface, type: Kind.Class, enum: Kind.Enum, "enum member": Kind.EnumMember,
  var: Kind.Variable, "local var": Kind.Variable, let: Kind.Variable, const: Kind.Constant, parameter: Kind.Variable,
  property: Kind.Field, getter: Kind.Field, setter: Kind.Field, accessor: Kind.Field, method: Kind.Method, constructor: Kind.Constructor,
  function: Kind.Function, "local function": Kind.Function, alias: Kind.Reference, string: Kind.Value, directory: Kind.Folder, script: Kind.File,
  "type parameter": Kind.TypeParameter,
};

monaco.languages.registerHoverProvider("html", {
  async provideHover(model, position) {
    const at = await componentPlace(model, position);
    if (!at) return null;
    const info = await (await tsClient()).getQuickInfoAtPosition(at.uri, at.offset);
    if (!info) return null;
    const signature = partsText(info.displayParts);
    const docs = partsText(info.documentation);
    if (!signature && !docs) return null;
    const contents: monaco.IMarkdownString[] = [];
    if (signature) contents.push({ value: "```typescript\n" + signature + "\n```" });
    if (docs) contents.push({ value: docs });
    return { range: componentRange(at.check, info.textSpan), contents };
  },
});

/** What a component's completion item needs to fetch its details. */
interface ComponentCompletion extends monaco.languages.CompletionItem {
  readonly place: { uri: string; offset: number };
}

monaco.languages.registerCompletionItemProvider("html", {
  triggerCharacters: [".", '"', "'", "/"],
  async provideCompletionItems(model, position) {
    if (!inComponentCode(model.getValue(), model.getOffsetAt(position))) return null;
    const at = await componentPlace(model, position);
    if (!at) return null;
    const info = await (await tsClient()).getCompletionsAtPosition(at.uri, at.offset);
    if (!info) return null;
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
    const suggestions: ComponentCompletion[] = [];
    for (const entry of info.entries as { name: string; kind: string; sortText: string; insertText?: string }[]) {
      if (isGeneratedName(entry.name)) continue;
      suggestions.push({
        label: entry.name,
        kind: COMPLETION_KINDS[entry.kind] ?? Kind.Property,
        sortText: entry.sortText,
        insertText: entry.insertText ?? entry.name,
        range,
        place: { uri: at.uri, offset: at.offset },
      });
    }
    return { suggestions };
  },
  async resolveCompletionItem(item) {
    const { place } = item as ComponentCompletion;
    const details = await (await tsClient()).getCompletionEntryDetails(place.uri, place.offset, String(item.label));
    if (!details) return item;
    return { ...item, detail: partsText(details.displayParts), documentation: partsText(details.documentation) || undefined };
  },
});

monaco.languages.registerSignatureHelpProvider("html", {
  signatureHelpTriggerCharacters: ["(", ","],
  async provideSignatureHelp(model, position) {
    if (!inComponentCode(model.getValue(), model.getOffsetAt(position))) return null;
    const at = await componentPlace(model, position);
    if (!at) return null;
    const help = await (await tsClient()).getSignatureHelpItems(at.uri, at.offset, {});
    if (!help) return null;
    type Item = { prefixDisplayParts: DisplayPart[]; suffixDisplayParts: DisplayPart[]; separatorDisplayParts: DisplayPart[]; documentation: DisplayPart[]; parameters: { displayParts: DisplayPart[]; documentation: DisplayPart[] }[] };
    const signatures = (help.items as Item[]).map((item) => {
      const params = item.parameters.map((p) => ({ label: partsText(p.displayParts), documentation: partsText(p.documentation) || undefined }));
      return {
        label: partsText(item.prefixDisplayParts) + params.map((p) => p.label).join(partsText(item.separatorDisplayParts)) + partsText(item.suffixDisplayParts),
        documentation: partsText(item.documentation) || undefined,
        parameters: params,
      };
    });
    return { value: { signatures, activeSignature: help.selectedItemIndex, activeParameter: help.argumentIndex }, dispose() {} };
  },
});

monaco.languages.registerDefinitionProvider("html", {
  async provideDefinition(model, position) {
    const at = await componentPlace(model, position);
    if (!at) return null;
    const found = (await (await tsClient()).getDefinitionAtPosition(at.uri, at.offset)) as { fileName: string; textSpan: { start: number; length: number } }[] | undefined;
    const out: monaco.languages.Location[] = [];
    for (const d of found ?? []) {
      // In a component (its own TypeScript or another's): back to the component; in a project file: its model.
      const component = [...componentLibs.values()].find((e) => codeFileUri(e.check.generated) === d.fileName);
      if (component) {
        const range = componentRange(component.check, d.textSpan);
        if (range) out.push({ uri: uriOf(component.check.path), range });
        continue;
      }
      const target = monaco.editor.getModel(monaco.Uri.parse(d.fileName));
      if (!target || codeFilePath(target.uri) === null) continue; // the engine's or a package's declarations: no model to open
      const start = target.getPositionAt(d.textSpan.start);
      const end = target.getPositionAt(d.textSpan.start + d.textSpan.length);
      out.push({ uri: target.uri, range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column } });
    }
    return out;
  },
});

/**
 * Type-check `project`'s scripts (paths in `files`, its `bufferTexts`, under scripts/), rune modules and
 * Svelte components (ADR 0432) with the TypeScript service, as the Code panel shows them: their syntax
 * and type errors (not warnings or suggestions), in path then line order.
 */
export async function checkScripts(project: unknown, files: ReadonlyMap<string, string>): Promise<ScriptDiagnostic[]> {
  syncProject(project, files);
  const scripts = [...files.keys()].filter((p) => isScriptPath(p) || (isRuneModulePath(p) && p.endsWith(".ts"))).sort(); // plugin sources too (ADR 0139), and rune modules (ADR 0423)
  const components = [...files.keys()].some(isSvelteComponentPath); // and Svelte components (ADR 0432)
  if (scripts.length === 0 && !components) return [];
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
  if (components) for (const e of await componentErrors()) out.push({ path: e.path, line: e.line, column: e.column, message: e.message });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
