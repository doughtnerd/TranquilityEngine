import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Plugin } from "vite";

/**
 * Compile TypeScript (and TSX) with tsc instead of Vite's default transformer (oxc), which does
 * not lower standard ES decorators (used for scene field declarations, see ADR 0013). JSX is
 * compiled for Preact, which the editor UI uses (ADR 0025). Used by the dev server, all builds
 * and Vitest, so they emit the same code. Configs that use it must also set `oxc: false`.
 */
export function typescriptTranspile(): Plugin {
  return {
    name: "tranquility:tsc-transpile",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      const isTs = file.endsWith(".ts") || file.endsWith(".tsx");
      if (!isTs || file.endsWith(".d.ts") || file.includes("node_modules")) return null;
      const out = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: true,
          jsx: ts.JsxEmit.ReactJSX,
          jsxImportSource: "preact",
          sourceMap: true,
          inlineSources: true,
        },
      });
      return { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
    },
  };
}

/** The module the editor imports the engine's declarations from (ADR 0030). */
const ENGINE_TYPES = "virtual:tranquility-types";

/**
 * The engine's public type declarations as a virtual module, `virtual:tranquility-types`: an
 * object of `.d.ts` text by path (`index.d.ts`, `core/World.d.ts`, ...), emitted in memory with
 * `tsconfig.engine.json`'s settings (internals stripped, editor access left out). The editor's
 * code editor serves them as the `"tranquility"` package (ADR 0030). Regenerated when an engine
 * source file changes.
 */
export function engineTypes(): Plugin {
  const resolved = `\0${ENGINE_TYPES}`;
  return {
    name: "tranquility:engine-types",
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
      const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: false, declaration: true, emitDeclarationOnly: true } });
      const outDir = config.options.outDir!.replace(/\\/g, "/");
      const files: Record<string, string> = {};
      program.emit(undefined, (fileName, text) => {
        const rel = fileName.replace(/\\/g, "/");
        files[rel.startsWith(`${outDir}/`) ? rel.slice(outDir.length + 1) : rel] = text;
      });
      for (const f of config.fileNames) this.addWatchFile(f);
      return `export default ${JSON.stringify(files)};`;
    },
  };
}
