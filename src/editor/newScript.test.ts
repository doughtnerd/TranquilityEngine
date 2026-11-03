import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { getDataComponentDef } from "../engine/core/data";
import { listComponents } from "../engine/editor";
import { activeScript, closeAllScripts, openScripts } from "./code/codeState";
import { createScript, scriptFolderFor } from "./newScript";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets } from "./projects";
import { loadScripts, replaceScripts } from "./scriptLoader";
import { scriptId, scriptName, scriptTemplate, whyNotScriptName } from "./scriptTemplates";
import { currentProject, openScene, sceneCamera, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

describe("script names", () => {
  it("turn what's typed into a PascalCase name", () => {
    expect(scriptName("enemy spawner")).toBe("EnemySpawner");
    expect(scriptName("  health-bar ")).toBe("HealthBar");
    expect(scriptName("Already")).toBe("Already");
  });

  it("must be identifiers, new files, and new ids", () => {
    const scripts = new Map([["scripts/Wheel.ts", `@behavior("game.Wheel") export class Wheel {}`], ["scripts/ai/Brain.ts", `@behavior("game.Spin") export class X {}`]]);
    expect(whyNotScriptName("", "scripts", scripts)).toMatch(/Type a name/);
    expect(whyNotScriptName("3D", "scripts", scripts)).toMatch(/not starting with a digit/);
    expect(whyNotScriptName("Wheel", "scripts", scripts)).toMatch(/already exists/);
    expect(whyNotScriptName("Spin", "scripts", scripts)).toMatch(/scripts\/ai\/Brain\.ts already defines game\.Spin/);
    expect(whyNotScriptName("Wheel", "scripts/ai", scripts)).toMatch(/scripts\/Wheel\.ts already defines/);
    expect(whyNotScriptName("Mover", "scripts", scripts)).toBeNull();
  });

  it("go in the Assets panel's folder when it's under scripts/", () => {
    expect(scriptFolderFor("scripts/ai")).toBe("scripts/ai");
    expect(scriptFolderFor("scripts")).toBe("scripts");
    expect(scriptFolderFor("images")).toBe("scripts");
    expect(scriptFolderFor("")).toBe("scripts");
  });
});

describe("script templates", () => {
  afterEach(() => replaceScripts(new Map()));

  it("each compile, load and register their id", async () => {
    const result = await loadScripts(
      new Map([
        ["scripts/Mover.ts", scriptTemplate("behavior", "Mover")],
        ["scripts/Heat.ts", scriptTemplate("data", "Heat")],
        ["scripts/Cool.ts", scriptTemplate("system", "Cool")],
      ]),
    );
    expect(result.problems).toEqual([]);
    expect(getComponentClass(scriptId("Mover"))).toBeDefined();
    expect(getDataComponentDef(scriptId("Heat"))).toBeDefined();
    expect(result.registered.systems).toEqual(["game.Cool"]);
  });
});

describe("creating a script", () => {
  let fs: MemoryFileSystem;

  beforeEach(async () => {
    Input.reset();
    closeAllScripts();
    fs = demoFolder();
    const project = await openFolderProject(fs, ROOT);
    useProjectAssets(project);
    currentProject.value = project;
    const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
    sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    openSceneFile(engine, project.mainScene!);
  });

  afterEach(() => replaceScripts(new Map()));

  it("writes it from the template, loads it, opens it in the Code panel and adds it to nodes", async () => {
    const path = await createScript("behavior", "Mover", "scripts", [["ceiling"], ["bird"]]);
    expect(path).toBe("scripts/Mover.ts");
    expect(fs.files.get(joinPath(ROOT, "scripts/Mover.ts"))).toBe(scriptTemplate("behavior", "Mover"));
    expect(openScripts.value).toEqual(["scripts/Mover.ts"]);
    expect(activeScript.value).toBe("scripts/Mover.ts");
    for (const id of ["ceiling", "bird"]) {
      expect(listComponents(openScene.value!.sync.nodeFor(id)!).map((c) => c.type)).toContain("game.Mover");
    }
    expect(openScene.value!.stack.undoLabel).toBe("Add Mover to 2 nodes");
    expect(status.value?.text).toBe("Created scripts/Mover.ts and added Mover.");
  });

  it("doesn't add a system to nodes", async () => {
    await createScript("system", "Cool", "scripts", [["ceiling"]]);
    expect(listComponents(openScene.value!.sync.nodeFor("ceiling")!).map((c) => c.type)).not.toContain("game.Cool");
    expect(status.value?.text).toBe("Created scripts/Cool.ts.");
  });
});
