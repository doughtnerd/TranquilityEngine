// Module hooks that let Node run the engine's TypeScript source directly (the dedicated server,
// T14). Plain JavaScript, since it's what makes TypeScript loadable.
//
// Node's own type stripping isn't enough: the engine uses standard decorators (not erasable
// syntax) and extensionless relative imports ("../core/World"), as Vite allows. So:
// - resolve: a relative specifier from a .ts file that names no existing file is tried by the shared
//   relative import rule (`relativeImportCandidates` in ../scriptCompiler.mjs, ADR 0332: `.ts`,
//   `.js` → `.ts`, `/index.ts`), as Vite and `moduleResolution: "Bundler"` do;
// - load: .ts files are compiled with the `typescript` package's `transpileModule`, with the shared
//   emit settings (`SCRIPT_EMIT`: ES2022, ES modules, define-semantics class fields, standard
//   decorators lowered), plus an inline source map for stack traces. The output is cached on disk
//   by content (node_modules/.cache/myco-server-ts): compiling the 260-odd engine files the server
//   loads takes seconds of CPU, and every start would otherwise pay it again.
//
// The hooks work both in-thread (`module.registerHooks`, Node 22.15+) and off-thread
// (`module.register`), since they only return what `nextResolve`/`nextLoad` give or a result of
// their own. Everything else (packages, `node:` modules, the `data:` URLs project scripts load
// from) passes through untouched.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { compilerOptions, relativeImportCandidates, SCRIPT_EMIT } from "../scriptCompiler.mjs";

const isFile = (path) => existsSync(path) && statSync(path).isFile();

const COMPILER_OPTIONS = { ...compilerOptions(SCRIPT_EMIT), inlineSourceMap: true, inlineSources: true };

/** Compiled files by a hash of the compiler, its options, the file's path (in the source map) and its text. */
const CACHE = fileURLToPath(new URL("../../node_modules/.cache/myco-server-ts/", import.meta.url));
const CACHE_KEY = `${ts.version}\n${JSON.stringify(COMPILER_OPTIONS)}\n`;

/** `file`'s JavaScript: from the cache, else compiled (and cached where the folder is writable). */
function compile(file, source) {
  const hash = createHash("sha256").update(CACHE_KEY).update(file).update("\0").update(source).digest("hex");
  const cached = join(CACHE, hash.slice(0, 2), `${hash}.js`);
  try {
    return readFileSync(cached, "utf8");
  } catch {
    // not compiled yet
  }
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: COMPILER_OPTIONS }).outputText;
  try {
    mkdirSync(dirname(cached), { recursive: true });
    const partial = `${cached}.${process.pid}.tmp`; // another process may be writing the same entry
    writeFileSync(partial, output);
    renameSync(partial, cached);
  } catch {
    // a read-only install runs without the cache
  }
  return output;
}

export function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL;
  if (parent?.startsWith("file:") && parent.endsWith(".ts") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const base = fileURLToPath(new URL(specifier, parent));
    const found = relativeImportCandidates(base).find(isFile);
    if (found) return { url: pathToFileURL(found).href, format: found.endsWith(".ts") ? "module" : undefined, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts") && !url.endsWith(".d.ts")) {
    const file = fileURLToPath(url);
    return { format: "module", source: compile(file, readFileSync(file, "utf8")), shortCircuit: true };
  }
  return nextLoad(url, context);
}
