import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { Bird } from "../../samples/flappy/scripts/behaviors/Bird";
import { listComponents } from "../engine/editor";
import { removeMissingComponent, whyNotRemovableMissing } from "./componentEdits";
import { AddComponent, SetOverrides, type SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { reloadScripts, saveScript } from "./session";
import { currentProject, openScene, playState, sceneCamera, scriptProblems, status } from "./state";
import { MemoryFileSystem, ROOT, demoFolder } from "./testing";

const wheel = (extra = "") => `
import { GameBehavior, behavior, field } from "tranquility";
@behavior("game.Wheel")
export class Wheel extends GameBehavior {
  @field(Number) speed = 1;
  ${extra}
}
`;

let fs: MemoryFileSystem;
let project: EditorProject;
const file = (path: string) => joinPath(ROOT, path);

/** Open the demo folder (plus `scripts`) the way the session does, headless. */
async function open(scripts: Record<string, string>, addWheelNode = true): Promise<void> {
  Input.reset();
  fs = demoFolder();
  for (const [path, text] of Object.entries(scripts)) fs.files.set(file(path), text);
  if (addWheelNode) {
    const scene = JSON.parse(fs.files.get(file("scenes/main.scene.json")) as string) as SceneFile;
    scene.nodes.push({ id: "wheel", name: "Wheel", components: [{ type: "engine.Transform" }, { type: "game.Wheel", data: { speed: 12 } }] });
    fs.files.set(file("scenes/main.scene.json"), JSON.stringify(scene));
  }
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  const result = await replaceScripts(project.scripts);
  scriptProblems.value = result.problems;
  const engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
}

const wheelComponent = () => listComponents(openScene.value!.sync.nodeFor("wheel")!).find((c) => c.type === "game.Wheel");
const valueOf = (field: string) => wheelComponent()?.fields.find((f) => f.name === field)?.value;

afterEach(async () => {
  playState.value = "edit";
  await replaceScripts(new Map()); // unload, so the next test starts from the editor build's types
});

describe("reloading scripts (ADR 0030)", () => {
  beforeEach(() => open({ "scripts/Wheel.ts": wheel() }));

  it("picks up a changed script and rebuilds the scene, keeping values from the scene file", async () => {
    expect(valueOf("speed")).toBe(12);
    const before = getComponentClass("game.Wheel");
    fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 5;`));
    await reloadScripts();
    expect(getComponentClass("game.Wheel")).not.toBe(before);
    expect(valueOf("speed")).toBe(12); // from the document
    expect(valueOf("power")).toBe(5); // the new field's default
    expect(status.value).toMatchObject({ kind: "info", text: "Reloaded 1 script." });
  });

  it("shows a deleted script's components as missing, keeping their data, until the script returns", async () => {
    fs.files.delete(file("scripts/Wheel.ts"));
    await reloadScripts();
    expect(getComponentClass("game.Wheel")).toBeUndefined();
    const { doc, sync } = openScene.value!;
    expect(wheelComponent()).toBeUndefined();
    expect(sync.missingComponents(["wheel"])).toEqual([{ type: "game.Wheel", data: { speed: 12 } }]);
    expect(doc.node("wheel").components!.map((c) => c.type)).toContain("game.Wheel"); // still in the scene

    fs.files.set(file("scripts/Wheel.ts"), wheel());
    await reloadScripts();
    expect(valueOf("speed")).toBe(12);
    expect(sync.missingComponents(["wheel"])).toEqual([]);
  });

  it("reports a script that breaks, and treats its types as missing", async () => {
    fs.files.set(file("scripts/Wheel.ts"), "export class = ;");
    await reloadScripts();
    expect(scriptProblems.value.map((p) => p.path)).toEqual(["scripts/Wheel.ts"]);
    expect(status.value?.kind).toBe("error");
    expect(openScene.value!.sync.missingComponents(["wheel"])).toHaveLength(1);
  });

  it("waits until play mode stops", async () => {
    const before = getComponentClass("game.Wheel");
    playState.value = "playing";
    fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 5;`));
    await reloadScripts();
    expect(getComponentClass("game.Wheel")).toBe(before);
    expect(status.value?.text).toMatch(/reload when you stop playing/);
  });

  it("reloads on a change from outside the editor, but not when the files match what's loaded", async () => {
    status.value = null;
    const before = getComponentClass("game.Wheel");
    await reloadScripts({ outside: true }); // e.g. the watcher seeing the editor's own save
    expect(getComponentClass("game.Wheel")).toBe(before);
    expect(status.value).toBeNull();

    fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 7;`));
    await reloadScripts({ outside: true });
    expect(valueOf("power")).toBe(7);
    expect(status.peek()?.text).toBe("Scripts changed on disk; reloaded them."); // peek: TypeScript narrowed .value to null above
  });

  it("saving a script writes it and reloads", async () => {
    await saveScript("scripts/Wheel.ts", wheel(`@field(Number) power = 9;`));
    expect(fs.files.get(file("scripts/Wheel.ts"))).toContain("power = 9");
    expect(valueOf("power")).toBe(9);
    await expect(saveScript("scenes/x.ts", "")).rejects.toThrow(/isn't a script/);
  });
});

describe("switching projects", () => {
  it("unregisters the old project's types, putting back the editor build's", async () => {
    await open({ "scripts/Bird.ts": `import { GameBehavior, behavior } from "tranquility";\n@behavior("game.Bird") export class Bird extends GameBehavior {}\n` }, false);
    expect(getComponentClass("game.Bird")).not.toBe(Bird); // the project's Bird replaced the demo's
    await replaceScripts(new Map());
    expect(getComponentClass("game.Bird")).toBe(Bird);
  });
});

describe("missing components", () => {
  beforeEach(() => open({}, true)); // the scene uses game.Wheel, but no script defines it

  it("load anyway in the editor and can be removed from a plain node, undoably", () => {
    const scene = openScene.value!;
    expect(scene.sync.missingComponents(["wheel"])).toHaveLength(1);
    expect(whyNotRemovableMissing(scene.doc, ["wheel"], "game.Wheel", 0, 1)).toBeNull();
    expect(removeMissingComponent(scene, ["wheel"], "game.Wheel", 0, 1)).toBe(true);
    expect(scene.doc.node("wheel").components!.map((c) => c.type)).toEqual(["engine.Transform"]);
    expect(scene.sync.missingComponents(["wheel"])).toEqual([]);
    scene.stack.undo();
    expect(scene.sync.missingComponents(["wheel"])).toHaveLength(1);
  });

  it("on a prefab instance: an added one goes with its overrides; one from the prefab stays", () => {
    const scene = openScene.value!;
    scene.stack.execute(
      new SetOverrides("bg-a", "ghost", [
        { addComponent: { type: "game.Ghost", data: { boo: 1 } } },
        { component: "game.Ghost", field: "boo", value: 2 }, // aimed at the missing component: skipped, kept
      ]),
    );
    expect(scene.sync.missingComponents(["bg-a"])).toEqual([{ type: "game.Ghost", data: { boo: 1 } }]);
    removeMissingComponent(scene, ["bg-a"], "game.Ghost", 0, 1);
    expect(scene.doc.node("bg-a").overrides).toBeUndefined();
    expect(whyNotRemovableMissing(scene.doc, ["bg-a"], "game.Ghost", 0, 1)).toMatch(/comes from the prefab/); // none added any more
  });

  it("a component added to a plain node with an unknown type shows as missing", () => {
    const scene = openScene.value!;
    scene.stack.execute(new AddComponent("ceiling", { type: "game.Nope" }));
    expect(scene.sync.missingComponents(["ceiling"])).toEqual([{ type: "game.Nope" }]);
  });
});
