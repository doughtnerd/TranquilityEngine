import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compilerOptions, relativeImportCandidates, SCRIPT_CHECK, SCRIPT_EMIT } from "./scriptCompiler.mjs";

describe("script compiler settings", () => {
  it("convert to the compiler API's form exactly as TypeScript converts a tsconfig.json", () => {
    for (const settings of [SCRIPT_EMIT, SCRIPT_CHECK]) {
      const converted = ts.convertCompilerOptionsFromJson(settings, "");
      expect(converted.errors).toEqual([]);
      expect(compilerOptions(settings)).toEqual(converted.options);
    }
  });

  it("emit ES2022 modules with define-semantics fields, and check with Bundler resolution", () => {
    expect(compilerOptions(SCRIPT_EMIT)).toEqual({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: true });
    expect(compilerOptions(SCRIPT_CHECK)).toMatchObject({ ...compilerOptions(SCRIPT_EMIT), moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, resolveJsonModule: true });
  });

  it("lower standard decorators with the emit settings", () => {
    const out = ts.transpileModule("const d = (v: unknown) => v;\n@d class A { @d x = 1; }\n", { compilerOptions: compilerOptions(SCRIPT_EMIT) });
    expect(out.outputText).not.toMatch(/^\s*@d/m);
    expect(out.outputText).toContain("__esDecorate");
  });

  it("name an unknown enum value instead of passing it through", () => {
    expect(() => compilerOptions({ ...SCRIPT_EMIT, target: "ES5" as "ES2022" })).toThrow(/target "ES5"/);
  });
});

describe("relative import candidates", () => {
  it("try the path as written, then .ts, .js swapped for .ts, then index.ts", () => {
    expect(relativeImportCandidates("scripts/util")).toEqual(["scripts/util", "scripts/util.ts", "scripts/util", "scripts/util/index.ts"]);
    expect(relativeImportCandidates("scripts/util.js")).toEqual(["scripts/util.js", "scripts/util.js.ts", "scripts/util.ts", "scripts/util.js/index.ts"]);
  });
});
