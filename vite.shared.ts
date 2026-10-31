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
