// The public `myco` module as scripts and games see it: the declarations the engine library publishes and the code
// editor serves (`virtual:myco-types`, emitted with tsconfig.engine.json's settings). Its export list is recorded in
// `myco.exports.txt`, so a change to the public API shows up as a diff there (ADR 0447), and nothing it reaches names a
// renderer, physics or audio library (ADR 0010).
import ts from "typescript";
import declarations from "virtual:myco-types";
import { describe, expect, it } from "vitest";

const ROOT = "/types";
const files = new Map(Object.entries(declarations).map(([path, text]) => [`${ROOT}/${path}`, text]));

/** The relative module specifiers and the bare ones (packages) a declaration file imports or re-exports. */
function specifiersOf(text: string): string[] {
  const out: string[] = [];
  const info = ts.preProcessFile(text, true, true);
  for (const ref of info.importedFiles) out.push(ref.fileName);
  // `import("…")` type queries in declarations.
  for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

/** A relative specifier from `from`, as a key of `files` (`.d.ts` or `/index.d.ts`), or null. */
function resolve(from: string, spec: string): string | null {
  const base = from.slice(0, from.lastIndexOf("/"));
  const parts = `${base}/${spec}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== ".") out.push(p);
  }
  const path = out.join("/").replace(/\.(js|ts)$/, "");
  for (const candidate of [`${path}.d.ts`, `${path}/index.d.ts`]) if (files.has(candidate)) return candidate;
  return null;
}

/** Every declaration file `myco.d.ts` reaches, and the packages they import. */
function reach(): { files: Set<string>; packages: Map<string, string[]> } {
  const seen = new Set<string>();
  const packages = new Map<string, string[]>();
  const queue = [`${ROOT}/myco.d.ts`];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(files.get(file)!)) {
      if (spec.startsWith(".")) {
        const target = resolve(file, spec);
        if (target) queue.push(target);
      } else packages.set(spec, [...(packages.get(spec) ?? []), file.slice(ROOT.length + 1)]);
    }
  }
  return { files: seen, packages };
}

/** `myco`'s exports, one `name: value|type` line each, sorted. */
function exportList(): string {
  const options: ts.CompilerOptions = { noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true };
  const host = ts.createCompilerHost(options);
  const fileExists = (f: string) => files.has(f) || ts.sys.fileExists(f);
  const readFile = (f: string) => files.get(f) ?? ts.sys.readFile(f);
  Object.assign(host, {
    fileExists,
    readFile,
    directoryExists: (d: string) => [...files.keys()].some((f) => f.startsWith(`${d}/`)) || ts.sys.directoryExists(d),
    getCurrentDirectory: () => ROOT,
    getSourceFile: (f: string, version: ts.ScriptTarget) => {
      const text = readFile(f);
      return text === undefined ? undefined : ts.createSourceFile(f, text, version);
    },
  });
  const program = ts.createProgram({ rootNames: [`${ROOT}/myco.d.ts`], options, host });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(`${ROOT}/myco.d.ts`)!)!;
  return checker
    .getExportsOfModule(module)
    .map((s) => {
      const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
      return `${s.name}: ${target.flags & ts.SymbolFlags.Value ? "value" : "type"}`;
    })
    .sort()
    .join("\n");
}

describe("the public myco module", () => {
  it("exports exactly the recorded names (a public API change is a diff of myco.exports.txt)", async () => {
    const list = exportList();
    expect(list.split("\n").length).toBeGreaterThan(500);
    await expect(`${list}\n`).toMatchFileSnapshot("./myco.exports.txt");
  });

  it("reaches no Babylon.js, three.js, Rapier or Howler type through its declarations (ADR 0010)", () => {
    const { files: reached, packages } = reach();
    // The walk works: it reaches the core and the plugins' public modules.
    expect(reached.size).toBeGreaterThan(100);
    expect([...reached].some((f) => f.includes("/plugins/sky/"))).toBe(true);
    const banned = [...packages].filter(([name]) => /^(@babylonjs\/|three($|\/)|@dimforge\/|howler($|\/))/.test(name));
    expect(banned).toEqual([]);
  });
});
