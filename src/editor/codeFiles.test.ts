import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { assetKind, opensInCodePanel } from "./assetBrowser";
import { codeFiles } from "./code/codeBuffers";
import { planWebBuild } from "../export/webBuild";
import { OrbitCamera } from "./OrbitCamera";
import { codeLanguageOf, isScriptPath, isTextAsset } from "./projectPaths";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, jsonFiles, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { loadOrder } from "../projectCode/loadOrder";
import { loadScripts, replaceScripts } from "./scriptLoader";
import { reloadScripts, saveCodeFile } from "./session";
import { currentProject, sceneCamera, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

const LEVELS = `{ "speed": 4, "names": ["one", "two"] }`;
const RACER = `import { GameBehavior, behavior, field } from "myco";
import levels from "../data/levels.json";
@behavior("game.Racer")
export class Racer extends GameBehavior {
  @field(Number) speed = levels.speed;
}
`;

describe("JSON imports in scripts", () => {
  afterEach(() => replaceScripts(new Map()));

  it("give the file's contents as the default export", async () => {
    const result = await loadScripts(new Map([["scripts/Racer.ts", RACER]]), new Map([["data/levels.json", LEVELS]]));
    expect(result.problems).toEqual([]);
    expect((new (getComponentClass("game.Racer") as new () => { speed: number })()).speed).toBe(4);
  });

  it("report invalid or missing JSON against the importing script", () => {
    const compiled = new Map([["scripts/a.ts", { path: "scripts/a.ts", code: "", imports: [{ specifier: "../data/bad.json", start: 0, end: 0 }] }]]);
    expect(loadOrder(compiled, new Map([["data/bad.json", false]])).problems).toEqual([{ path: "scripts/a.ts", message: "can't import data/bad.json: it isn't valid JSON" }]);
    expect(loadOrder(compiled, new Map()).problems[0].message).toMatch(/can't find "\.\.\/data\/bad\.json"/);
  });
});

describe("which files the Code panel edits", () => {
  it("keeps JSON, JavaScript and TypeScript modules, Markdown and text as text; not scripts, binaries or unknown files", () => {
    for (const path of ["data/a.json", "tools/a.js", "tools/a.mjs", "tools/a.cjs", "tools/a.mts", "tools/a.cts", "tools/README.md", "notes.txt", "tools/GEN.MJS"]) expect(isTextAsset(path), path).toBe(true);
    for (const path of ["scripts/a.ts", "scripts/a.d.ts", "images/a.png", "tools/a.sh", "tools/mjs", ".mjs", "tools/a.mjs.bak"]) expect(isTextAsset(path), path).toBe(false);
  });

  it("highlights each kind in its language", () => {
    expect(codeLanguageOf("data/a.json")).toBe("json");
    expect(codeLanguageOf("tools/a.js")).toBe("javascript");
    expect(codeLanguageOf("tools/generate.mjs")).toBe("javascript");
    expect(codeLanguageOf("tools/a.CJS")).toBe("javascript");
    expect(codeLanguageOf("tools/a.mts")).toBe("typescript");
    expect(codeLanguageOf("tools/a.cts")).toBe("typescript");
    expect(codeLanguageOf("tools/README.md")).toBe("markdown");
    expect(codeLanguageOf("notes.txt")).toBe("plaintext");
    expect(codeLanguageOf("scripts/Player.ts")).toBe("typescript");
  });

  it("gives them asset kinds that open in the Code panel, and only scripts/*.ts are scripts", () => {
    expect(assetKind("tools/generate.mjs")).toBe("javascript");
    expect(assetKind("tools/lib.cjs")).toBe("javascript");
    expect(assetKind("tools/types.mts")).toBe("typescript");
    expect(assetKind("tools/types.cts")).toBe("typescript");
    expect(assetKind("tools/README.md")).toBe("text");
    expect(assetKind("notes.TXT")).toBe("text");
    for (const kind of ["script", "json", "javascript", "typescript", "text"] as const) expect(opensInCodePanel(kind)).toBe(true);
    for (const kind of ["scene", "prefab", "image", "shadergraph", "other", "folder"] as const) expect(opensInCodePanel(kind)).toBe(false);
    expect(isScriptPath("scripts/tool.mts")).toBe(false);
    expect(isScriptPath("scripts/tool.mjs")).toBe(false);
    expect(isScriptPath("scripts/Player.ts")).toBe(true);
  });

  it("leaves TypeScript modules out of game builds (as scripts, which ship compiled) and copies the rest as files", async () => {
    const files = ["project.json", "tools/types.mts", "tools/types.cts", "tools/generate.mjs", "tools/README.md"];
    const { copies } = await planWebBuild({ name: "t", settings: {}, files, scripts: new Map(), json: new Map() });
    expect(copies).not.toContain("tools/types.mts");
    expect(copies).not.toContain("tools/types.cts");
    expect(copies).toContain("tools/generate.mjs");
    expect(copies).toContain("tools/README.md");
  });
});

describe("JSON and JavaScript files in a project", () => {
  let fs: MemoryFileSystem;
  let project: EditorProject;

  beforeEach(async () => {
    Input.reset();
    fs = demoFolder();
    fs.files.set(joinPath(ROOT, "data/levels.json"), LEVELS);
    fs.files.set(joinPath(ROOT, "tools/build.js"), "console.log('hi');\n");
    fs.files.set(joinPath(ROOT, "scripts/Racer.ts"), RACER);
    project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    await replaceScripts(project.scripts, jsonFiles(project));
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, project.mainScene!);
  });

  afterEach(() => replaceScripts(new Map()));

  it("are listed as assets the Code panel can open, JavaScript as text", () => {
    expect(project.files).toContain("tools/build.js");
    expect(project.textOf("tools/build.js")).toBe("console.log('hi');\n");
    expect(assetKind("tools/build.js")).toBe("javascript");
    const files = codeFiles(project);
    expect(files.get("data/levels.json")).toBe(LEVELS);
    expect(files.get("tools/build.js")).toBe("console.log('hi');\n");
    expect(files.get("scripts/Racer.ts")).toBe(RACER);
  });

  it("save JavaScript as is, and JSON only when it parses", async () => {
    await saveCodeFile("tools/build.js", "export {};\n");
    expect(fs.files.get(joinPath(ROOT, "tools/build.js"))).toBe("export {};\n");
    expect(status.value?.text).toBe("Saved tools/build.js.");
    await expect(saveCodeFile("data/levels.json", "{ nope")).rejects.toThrow(/isn't valid JSON, so it wasn't saved/);
    expect(fs.files.get(joinPath(ROOT, "data/levels.json"))).toBe(LEVELS);
  });

  it("keep a Tiled tileset saved as .tsx as a project file, never a script, and leave TypeScript .tsx out (ADR 0436)", async () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    fs.files.set(joinPath(ROOT, "tiles/terrain.tsx"), bytes('\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<tileset name="terrain"/>\n'));
    fs.files.set(joinPath(ROOT, "tiles/bare.tsx"), bytes('<tileset name="bare"/>\n'));
    fs.files.set(joinPath(ROOT, "tools/App.tsx"), bytes("export const App = () => <div />;\n"));
    project = await openFolderProject(fs, ROOT);
    expect(project.files).toContain("tiles/terrain.tsx");
    expect(project.files).toContain("tiles/bare.tsx");
    expect(project.files).not.toContain("tools/App.tsx");
    expect([...project.scripts.keys()].some((p) => p.endsWith(".tsx"))).toBe(false);
  });

  it("list tool modules, Markdown and text as files the Code panel opens, but not as scripts", async () => {
    const tools = { "tools/generate.mjs": "import { lib } from './lib.mjs';\n", "tools/lib.cjs": "module.exports = {};\n", "tools/types.mts": "export const n: number = 1;\n", "tools/old.cts": "export = 1;\n", "tools/README.md": "# Tools\n", "notes.txt": "todo\n" };
    for (const [path, text] of Object.entries(tools)) fs.files.set(joinPath(ROOT, path), text);
    fs.files.set(joinPath(ROOT, "tools/blob.xyz"), new Uint8Array([63]));
    project = await openFolderProject(fs, ROOT);
    const files = codeFiles(project);
    for (const [path, text] of Object.entries(tools)) {
      expect(project.files).toContain(path);
      expect(files.get(path)).toBe(text);
      expect(project.scripts.has(path)).toBe(false);
      expect(opensInCodePanel(assetKind(path))).toBe(true);
    }
    // A file of a kind the engine doesn't know is still a project file (ADR 0254), served by URL, not edited as text.
    expect(project.files).toContain("tools/blob.xyz");
    expect(files.has("tools/blob.xyz")).toBe(false);
    expect(project.assets.get("tools/blob.xyz")).toMatch(/^blob:/);
    expect([...project.scripts.keys()]).toEqual(["scripts/Racer.ts"]);
    // Script loading only compiles scripts/*.ts: the tools aren't loaded (nor imported as JSON).
    expect([...jsonFiles(project).keys()].some((p) => p.startsWith("tools/"))).toBe(false);
    const result = await replaceScripts(project.scripts, jsonFiles(project));
    expect(result.loaded).toEqual(["scripts/Racer.ts"]);
  });

  it("save tool modules and text as they are, without reloading scripts", async () => {
    fs.files.set(joinPath(ROOT, "tools/generate.mjs"), "console.log(1);\n");
    project = await openFolderProject(fs, ROOT);
    currentProject.value = project;
    await saveCodeFile("tools/generate.mjs", "console.log(2);\n");
    expect(fs.files.get(joinPath(ROOT, "tools/generate.mjs"))).toBe("console.log(2);\n");
    expect(project.textOf("tools/generate.mjs")).toBe("console.log(2);\n");
    expect(status.value?.text).toBe("Saved tools/generate.mjs.");
    await saveCodeFile("tools/NOTES.md", "# Notes\n"); // a new text file
    expect(fs.files.get(joinPath(ROOT, "tools/NOTES.md"))).toBe("# Notes\n");
    expect(codeFiles(project).get("tools/NOTES.md")).toBe("# Notes\n");
  });

  it("reload scripts after saving JSON a script imports", async () => {
    await saveCodeFile("data/levels.json", `{ "speed": 9, "names": [] }`);
    expect((new (getComponentClass("game.Racer") as new () => { speed: number })()).speed).toBe(9);
    await reloadScripts(); // and a plain reload reads the new JSON too
    expect((new (getComponentClass("game.Racer") as new () => { speed: number })()).speed).toBe(9);
  });
});
