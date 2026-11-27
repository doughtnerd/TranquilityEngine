// Compiling a project's Svelte UI code (ADR 0423) in the project code linker: components (`*.svelte`)
// with the engine's custom renderer and external CSS, rune modules (`*.svelte.ts`/`.svelte.js`), and plain
// `.css` files components import. Every host links through here, so the editor (dev: template locations)
// and the export (dev: false) emit the same code. CSS is parsed into the cascade's rule data now and written
// into the module (games ship no CSS parser). `svelte/compiler` and the parser load on first use, so only
// projects with Svelte UI pay for them, and they never reach a game build.
import { importSites, typescript } from "../editor/moduleImports";
import { compilerOptions, SCRIPT_EMIT } from "../scriptCompiler.mjs";
import type { CompiledScript, ScriptProblem } from "./compile";
import { isRuneModulePath, isSvelteComponentPath } from "./uiModules";

type Compiler = typeof import("../plugins/ui/svelte/compile.mjs");
type Parser = typeof import("../engine/ui/document/stylesheet");

let tools: Promise<{ compiler: Compiler; parser: Parser }> | null = null;

function loadTools(): Promise<{ compiler: Compiler; parser: Parser }> {
  tools ??= Promise.all([import("../plugins/ui/svelte/compile.mjs"), import("../engine/ui/document/stylesheet")]).then(
    ([compiler, parser]) => ({ compiler, parser }),
    (err: unknown) => {
      tools = null;
      throw err;
    },
  );
  return tools;
}

/** What a compile error says, with its line when Svelte gives one. */
function problemOf(path: string, err: unknown): ScriptProblem {
  const e = err as { message?: string; start?: { line?: number; column?: number }; code?: string };
  const text = String(e?.message ?? err).split("\n")[0].replace(/^[^:]*?\(\d+:\d+\):\s*/, "");
  return { path, message: e?.start?.line ? `line ${e.start.line}: ${text}` : text };
}

/**
 * Compile one UI source: a component, a rune module, or a `.css` file a component imports. `dev` compiles
 * components with template locations (the editor). Compile errors are problems; Svelte's warnings aren't.
 */
export async function compileUI(path: string, source: string, options: { dev: boolean }): Promise<CompiledScript | ScriptProblem> {
  const ts = await typescript();
  let code: string;
  try {
    const { compiler, parser } = await loadTools();
    const styles = (css: string, file: string) => parser.parseStylesheet(css, file);
    if (isSvelteComponentPath(path)) code = compiler.compileSvelteUI(source, { filename: path, dev: options.dev, styles }).code;
    else if (path.endsWith(".css")) code = compiler.compileSvelteUIStyles(source, { filename: path, styles }).code;
    else if (isRuneModulePath(path)) {
      let js = source;
      if (path.endsWith(".ts")) {
        const out = ts.transpileModule(source, { fileName: path, reportDiagnostics: true, compilerOptions: compilerOptions(SCRIPT_EMIT) });
        const error = out.diagnostics?.find((d) => d.category === ts.DiagnosticCategory.Error);
        if (error) {
          const where = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start) : null;
          const text = ts.flattenDiagnosticMessageText(error.messageText, "\n");
          return { path, message: where ? `line ${where.line + 1}: ${text}` : text };
        }
        js = out.outputText;
      }
      code = compiler.compileSvelteUIModule(js, { filename: path, dev: options.dev }).code;
    } else return { path, message: "isn't Svelte UI code (a .svelte component, a .svelte.ts rune module or a .css file a component imports)" };
  } catch (err) {
    return problemOf(path, err);
  }
  return { path, code, imports: importSites(ts, code) };
}
