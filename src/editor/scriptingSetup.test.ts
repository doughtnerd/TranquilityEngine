import ts from "typescript";
import declarations from "virtual:myco-types";
import { describe, expect, it } from "vitest";
import type { FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projects";
import { watchScripts, writeScriptingFiles } from "./scriptingSetup";
import { scriptTemplate } from "./scriptTemplates";
import { MemoryFileSystem, ROOT } from "./testing";

const at = (path: string) => joinPath(ROOT, path);
/** Where a project keeps the engine's declarations for external editors. */
const TYPES_DIR = ".myco/types/myco";

describe("files for external editors", () => {
  it("adds a scripts folder, a tsconfig.json and the engine's declarations", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(at("project.json"), "{}");
    expect(await writeScriptingFiles(fs, ROOT, { "index.d.ts": "export {};", "core/World.d.ts": "export {};" })).toEqual({ tsconfig: true, types: true });
    expect(JSON.parse(fs.files.get(at("tsconfig.json")) as string).compilerOptions.paths.myco).toEqual([`./${TYPES_DIR}/index.d.ts`]);
    expect(fs.files.get(at(`${TYPES_DIR}/core/World.d.ts`))).toBe("export {};");
    expect(JSON.parse(fs.files.get(at(`${TYPES_DIR}/package.json`)) as string)).toEqual({ name: "myco", types: "index.d.ts" });
  });

  it("keeps an existing tsconfig.json, and rewrites declarations only when they change", async () => {
    const fs = new MemoryFileSystem();
    fs.files.set(at("tsconfig.json"), "{ \"mine\": true }");
    await writeScriptingFiles(fs, ROOT, { "index.d.ts": "export {};" });
    expect(fs.files.get(at("tsconfig.json"))).toBe("{ \"mine\": true }");
    expect(await writeScriptingFiles(fs, ROOT, { "index.d.ts": "export {};" })).toEqual({ tsconfig: false, types: false });
    expect(await writeScriptingFiles(fs, ROOT, { "index.d.ts": "export declare const v: 2;" })).toEqual({ tsconfig: false, types: true });
    expect(fs.files.get(at(`${TYPES_DIR}/index.d.ts`))).toBe("export declare const v: 2;");
  });
});

describe("the generated tsconfig with the engine's declarations", () => {
  it("type-checks the script templates the way an external editor would, without errors", async () => {
    // The tsconfig.json a new project gets.
    const project = new MemoryFileSystem();
    await writeScriptingFiles(project, ROOT, {});
    // A project folder in memory; TypeScript's own lib files come from disk.
    const dir = "/project";
    const files = new Map<string, string>();
    files.set(`${dir}/tsconfig.json`, project.files.get(at("tsconfig.json")) as string);
    for (const [path, text] of Object.entries(declarations)) files.set(`${dir}/${TYPES_DIR}/${path}`, text);
    files.set(`${dir}/scripts/Mover.ts`, scriptTemplate("behavior", "Mover"));
    files.set(`${dir}/scripts/Heat.ts`, scriptTemplate("data", "Heat"));
    files.set(`${dir}/scripts/Cool.ts`, scriptTemplate("system", "Cool"));
    files.set(`${dir}/data/levels.json`, `{ "speed": 4 }`);
    files.set(`${dir}/scripts/Levels.ts`, `import levels from "../data/levels.json";
export const speed: number = levels.speed;
`);
    files.set(`${dir}/scripts/Uses.ts`, `import { Time, Vector3 } from "myco";\nexport const step: number = Time.deltaTime * new Vector3(1, 2, 3).x;\n`);
    // Components whose fields come from an engine base class (LineRenderer and TrailRenderer extend
    // RibbonRenderer): the base must be in the declarations, or they aren't Components to scripts.
    files.set(`${dir}/scripts/Lines.ts`, `import { Color, GameObject, LineRenderer, TrailRenderer } from "myco";
const node = GameObject.create("Line");
const line: LineRenderer = node.addComponent(LineRenderer, { width: 0.5, alignment: "transformZ" });
line.color = new Color(1, 1, 1, 0.5);
line.setPositions([[0, 0, 0], [1, 0, 0]]);
export const width: number = line.width + (node.getComponent(TrailRenderer)?.width ?? 0);
`);
    const fileExists = (f: string) => files.has(f) || ts.sys.fileExists(f);
    const readFile = (f: string) => files.get(f) ?? ts.sys.readFile(f);

    const config = ts.parseJsonConfigFileContent(
      JSON.parse(files.get(`${dir}/tsconfig.json`)!),
      { useCaseSensitiveFileNames: true, fileExists, readFile, readDirectory: () => [...files.keys()].filter((f) => f.startsWith(`${dir}/scripts/`)) },
      dir,
    );
    const host = ts.createCompilerHost(config.options);
    Object.assign(host, {
      fileExists,
      readFile,
      directoryExists: (d: string) => [...files.keys()].some((f) => f.startsWith(`${d}/`)) || ts.sys.directoryExists(d),
      getCurrentDirectory: () => dir,
      getSourceFile: (f: string, version: ts.ScriptTarget) => {
        const text = readFile(f);
        return text === undefined ? undefined : ts.createSourceFile(f, text, version);
      },
    });
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, host });
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(config.fileNames).toHaveLength(6);
    expect(errors).toEqual([]);
  });
});

describe("watching scripts", () => {
  it("reports changes to scripts, not to declarations or atomic-write temp files", async () => {
    let report: ((paths: string[]) => void) | null = null;
    const fs = { watch: async (_path: string, onChange: (paths: string[]) => void) => ((report = onChange), () => {}) } as unknown as FileSystem;
    let changes = 0;
    await watchScripts(fs, ROOT, () => changes++);
    report!([`${ROOT}\\scripts\\Wheel.ts.tmp-abc123`]);
    report!([`${ROOT}\\scripts\\types.d.ts`]);
    expect(changes).toBe(0);
    report!([`${ROOT}\\scripts\\ai\\Wheel.ts`]);
    expect(changes).toBe(1);
  });

  it("is unavailable where the file system can't watch", async () => {
    expect(await watchScripts(new MemoryFileSystem(), ROOT, () => {})).toBeNull();
  });
});
