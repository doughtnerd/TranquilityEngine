import ts from "typescript";
import type { Plugin } from "vite";

/**
 * Compile TypeScript with tsc instead of Vite's default transformer (oxc), which does not
 * lower standard ES decorators (used for scene field declarations, see ADR 0013).
 * Used by the dev server, both builds and Vitest, so they all emit the same code.
 * Configs that use it must also set `oxc: false`.
 */
export function typescriptTranspile(): Plugin {
  return {
    name: "tranquility:tsc-transpile",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file.includes("node_modules")) return null;
      const out = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          useDefineForClassFields: true,
          sourceMap: true,
          inlineSources: true,
        },
      });
      return { code: out.outputText, map: out.sourceMapText ? JSON.parse(out.sourceMapText) : null };
    },
  };
}
