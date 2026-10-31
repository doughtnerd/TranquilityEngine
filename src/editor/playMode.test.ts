import { beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Input, SceneManager } from "../engine";
import { World } from "../engine/core/World";
import { GameManager } from "../demo/flappy/behaviors/GameManager";
import { SetField } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay } from "./playMode";
import { openSceneFile } from "./project";
import { bundledDemoProject, editorSettings, useProjectAssets, type EditorProject } from "./projects";
import { openScene, sceneCamera } from "./state";

let editor: Engine;
let project: EditorProject;
const frame = 1 / 60;

beforeEach(async () => {
  Input.reset();
  project = bundledDemoProject();
  useProjectAssets(project);
  editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
  openSceneFile(editor, project.mainScene!);
});

describe("play mode (ADR 0022)", () => {
  it("runs the scene in a separate Runtime World with its scripts", async () => {
    const play = await startPlay({ editor, scene: openScene.value!, project });
    expect(World.active).toBe(play.engine.world);
    expect(play.engine.world.kind).toBe("runtime");
    for (let i = 0; i < 5; i++) play.engine.step(frame);
    const manager = GameObject.findObjectOfType(GameManager);
    expect(manager?.state).toBe("ready"); // the game's scripts run (they're suspended in the editor)
    play.stop();
  });

  it("plays unsaved edits, and edits during play don't reach the game", async () => {
    const { stack, sync } = openScene.value!;
    stack.execute(new SetField("bird", "engine.Transform", "position", [-2, 4, 0]));
    const play = await startPlay({ editor, scene: openScene.value!, project });
    play.engine.step(frame);
    const runtimeBird = GameObject.findObjectOfType(GameManager)!.bird!;
    expect(runtimeBird.transform!.position.x).toBe(-2);

    stack.execute(new SetField("bird", "engine.Transform", "position", [3, 4, 0]));
    expect(sync.nodeFor("bird")!.transform!.position.x).toBe(3); // the editor follows the edit…
    expect(runtimeBird.transform!.position.x).toBe(-2); // …the running game doesn't

    // Even when the game reloads its scene (Flappy's restart), it gets the snapshot from Play.
    await SceneManager.load("scenes/main.scene.json");
    play.engine.step(frame);
    expect(GameObject.findObjectOfType(GameManager)!.bird!.transform!.position.x).toBe(-2);
    play.stop();
  });

  it("stop tears the Runtime World down and resumes the editor as it was", async () => {
    const editorBird = openScene.value!.sync.nodeFor("bird")!;
    const before = editorBird.transform!.position.toArray();
    const play = await startPlay({ editor, scene: openScene.value!, project });
    for (let i = 0; i < 30; i++) play.engine.step(frame);
    const runtimeManager = GameObject.findObjectOfType(GameManager)!;
    play.stop();

    expect(World.active).toBe(editor.world);
    expect(runtimeManager.node.isValid).toBe(false); // destroyed, so scripts got onDestroy
    expect(play.engine.world.physics2D).toBeNull(); // Rapier world freed
    expect(editorBird.isValid).toBe(true);
    expect(editorBird.transform!.position.toArray()).toEqual(before);
    // The play snapshot no longer shadows the project's scene file.
    expect(Assets.json("scenes/main.scene.json")).toBe(project.assets.get("scenes/main.scene.json"));
  });

  it("resumes the editor if the scene can't start", async () => {
    const { stack } = openScene.value!;
    stack.execute(new SetField("bird", "engine.Transform", "position", [0, 0, 0]));
    // Break the snapshot: a component type nobody registered.
    openScene.value!.doc.node("bird").components!.push({ type: "game.Missing" });
    await expect(startPlay({ editor, scene: openScene.value!, project })).rejects.toThrow(/unknown component type "game.Missing"/);
    expect(World.active).toBe(editor.world);
    expect(Assets.json("scenes/main.scene.json")).toBe(project.assets.get("scenes/main.scene.json"));
  });
});

