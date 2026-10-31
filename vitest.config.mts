import ts from "typescript";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * Compile TypeScript with tsc instead of Vite's default transformer, which does not
 * lower standard ES decorators (used for scene field declarations, see ADR 0013).
 * This keeps test output identical to the ts-loader build.
 */
function typescriptTranspile(): Plugin {
  return {
    name: "tranquility:tsc-transpile",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".ts") || id.includes("node_modules")) return null;
      const out = ts.transpileModule(code, {
        fileName: id,
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

export default defineConfig({
  plugins: [typescriptTranspile()],
  oxc: false,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
