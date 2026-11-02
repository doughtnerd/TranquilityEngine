// Module hooks that let Node run the engine's TypeScript source directly (the dedicated server,
// T14). Plain JavaScript, since it's what makes TypeScript loadable.
//
// Node's own type stripping isn't enough: the engine uses standard decorators (not erasable
// syntax) and extensionless relative imports ("../core/World"), as Vite allows. So:
// - resolve: a relative specifier from a .ts file that names no existing file is tried with
//   `.ts`, `.js` → `.ts` and `/index.ts`, as Vite and `moduleResolution: "Bundler"` do;
// - load: .ts files are compiled with the `typescript` package's `transpileModule`, with the same
//   settings as `typescriptTranspile()` in vite.shared.ts (ES2022, ES modules, define-semantics
//   class fields, standard decorators lowered), plus an inline source map for stack traces.
//
// The hooks work both in-thread (`module.registerHooks`, Node 22.15+) and off-thread
// (`module.register`), since they only return what `nextResolve`/`nextLoad` give or a result of
// their own. Everything else (packages, `node:` modules, the `data:` URLs project scripts load
// from) passes through untouched.
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const isFile = (path) => existsSync(path) && statSync(path).isFile();

export function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL;
  if (parent?.startsWith("file:") && parent.endsWith(".ts") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const base = fileURLToPath(new URL(specifier, parent));
    const found = [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`].find(isFile);
    if (found) return { url: pathToFileURL(found).href, format: found.endsWith(".ts") ? "module" : undefined, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts") && !url.endsWith(".d.ts")) {
    const file = fileURLToPath(url);
    const out = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        useDefineForClassFields: true,
        inlineSourceMap: true,
        inlineSources: true,
      },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
