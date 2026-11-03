import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { assetKind } from "./assetBrowser";
import { codeFiles } from "./code/codeState";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, jsonFiles, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { loadOrder, loadScripts, replaceScripts } from "./scriptLoader";
import { reloadScripts, saveCodeFile } from "./session";
import { currentProject, sceneCamera, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

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

  it("reload scripts after saving JSON a script imports", async () => {
    await saveCodeFile("data/levels.json", `{ "speed": 9, "names": [] }`);
    expect((new (getComponentClass("game.Racer") as new () => { speed: number })()).speed).toBe(9);
    await reloadScripts(); // and a plain reload reads the new JSON too
    expect((new (getComponentClass("game.Racer") as new () => { speed: number })()).speed).toBe(9);
  });
});
