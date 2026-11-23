// Compiling one project script (ADR 0030) and resolving a relative import between scripts: the first
// step of linking a project's code (ADR 0329), the same in every host.
import { importSites, typescript, type ImportSite } from "../editor/moduleImports";
import { compilerOptions, relativeImportCandidates, SCRIPT_EMIT } from "../scriptCompiler.mjs";

/** The bare specifier scripts import the engine by. */
export const ENGINE_MODULE = "myco";
/** The engine's former name (ADR 0037), still accepted so existing scripts keep working. */
export const LEGACY_ENGINE_MODULE = "tranquility";
/** True for an import of the engine, by either name. */
export const isEngineModule = (specifier: string) => specifier === ENGINE_MODULE || specifier === LEGACY_ENGINE_MODULE;
/** The editor SDK (ADR 0133, 0139): only a plugin's editor half (`plugins/<folder>/editor/`) may import it. */
export const EDITOR_MODULE = "myco/editor";

/** Something wrong with a project's code: a script, or an npm plugin entry, by its path or specifier. */
export interface ScriptProblem {
  readonly path: string;
  readonly message: string;
}

/** A script compiled to JavaScript, with the imports found in it. */
export interface CompiledScript {
  readonly path: string;
  readonly code: string;
  readonly imports: readonly ImportSite[];
}

/**
 * Compile one script to JavaScript with the engine's own settings (`SCRIPT_EMIT`, ADR 0332: ES2022,
 * ES modules, define-semantics class fields, standard decorators), with
 * an inline source map so stack traces and the debugger show the TypeScript. Only syntax errors
 * stop it; type errors are the code editor's business. Game builds (ADR 0041) pass
 * `sourceMap: false`, so they don't ship the TypeScript.
 */
export async function compileScript(path: string, source: string, options: { sourceMap?: boolean } = {}): Promise<CompiledScript | ScriptProblem> {
  const ts = await typescript();
  const sourceMap = options.sourceMap ?? true;
  const out = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { ...compilerOptions(SCRIPT_EMIT), inlineSourceMap: sourceMap, inlineSources: sourceMap },
  });
  const error = out.diagnostics?.find((d) => d.category === ts.DiagnosticCategory.Error);
  if (error) {
    const where = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start) : null;
    const text = ts.flattenDiagnosticMessageText(error.messageText, "\n");
    return { path, message: where ? `line ${where.line + 1}: ${text}` : text };
  }
  return { path, code: out.outputText, imports: importSites(ts, out.outputText) };
}

/**
 * The script a relative specifier in `from` refers to, among `paths`, by the shared relative import
 * rule (`relativeImportCandidates`, ADR 0332). Null if none.
 */
export function resolveScript(from: string, specifier: string, paths: ReadonlySet<string>): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return relativeImportCandidates(parts.join("/")).find((c) => paths.has(c)) ?? null;
}
