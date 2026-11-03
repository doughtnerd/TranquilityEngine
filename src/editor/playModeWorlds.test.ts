import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Input, type BootstrapSetting, type ProjectSettingsInput } from "../engine";
import { World } from "../engine/core/World";
import { engineWorld, focusWorldInput, worldViewStates } from "../engine/editor";
import { GameManager } from "../../samples/flappy/scripts/behaviors/GameManager";
import { SetField } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay } from "./playMode";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets, type EditorProject } from "./projects";
import { replaceScripts } from "./scriptLoader";
import { openScene, sceneCamera } from "./state";
import { sampleProject } from "./testing";

let editor: Engine;
let sample: EditorProject;
const frame = 1 / 60;
const SCENE = "scenes/main.scene.json";

/** The sample project with `bootstrap` in its project.json. */
function withBootstrap(bootstrap: BootstrapSetting): EditorProject {
  const settings: ProjectSettingsInput = { ...sample.settings, bootstrap };
  return Object.defineProperty(Object.create(sample), "settings", { value: settings }) as EditorProject;
}

const CLIENT_SERVER: BootstrapSetting = {
  worlds: [
    { name: "Client", tags: ["client"] },
    { name: "Server", tags: ["server"] },
  ],
};

/** The bird's x in a World of `engine`: the GameManager's bird, found in that World. */
function birdX(engine: Engine, name: string): number {
  const world = engineWorld(engine, name)!;
  const manager = World._runIn(world, () => GameObject.findObjectOfType(GameManager))!;
  return manager.bird!.transform!.position.x;
}

beforeEach(async () => {
  Input.reset();
  sample = sampleProject();
  useProjectAssets(sample);
  editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(sample) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
  openSceneFile(editor, sample.mainScene!);
});

afterEach(async () => {
  editor.dispose();
  await replaceScripts(new Map());
});

describe("play mode with several Worlds (ADR 0032)", () => {
  it("builds the Engine from the project's bootstrap, and the open scene's snapshot loads in each World", async () => {
    openScene.value!.stack.execute(new SetField("bird", "engine.Transform", "position", [-2, 4, 0]));
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(CLIENT_SERVER) });
    expect(play.engine.worlds().map((w) => w.name)).toEqual(["Client", "Server"]);
    expect(play.engine.world.name).toBe("Client");
    for (let i = 0; i < 3; i++) play.engine.step(frame);
    // Both play the unsaved edit: the snapshot, not the file on disk.
    expect(birdX(play.engine, "Client")).toBe(-2);
    expect(birdX(play.engine, "Server")).toBe(-2);
    // The server doesn't render, so the client has the view and input.
    expect(worldViewStates(play.engine).map((s) => [s.name, s.renders, s.mainView, s.takesInput])).toEqual([
      ["Client", true, true, true],
      ["Server", false, false, false],
    ]);
    play.stop();
  });

  it("keeps the scenes a World's config lists, and serves them the snapshot too", async () => {
    const bootstrap: BootstrapSetting = {
      worlds: [
        { name: "Client", tags: ["client"], scenes: [SCENE] },
        { name: "Menu", tags: ["client"], scenes: ["prefabs/music.prefab.json"] },
      ],
    };
    openScene.value!.stack.execute(new SetField("bird", "engine.Transform", "position", [-3, 4, 0]));
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(bootstrap) });
    play.engine.step(frame);
    expect(birdX(play.engine, "Client")).toBe(-3);
    const menu = engineWorld(play.engine, "Menu")!;
    expect(menu.sceneNodes.map((n) => n.name)).toEqual(["music.prefab"]); // its own scene, not the open one
    play.stop();
  });

  it("leaves a World whose config says scenes: [] empty, as a build would", async () => {
    const bootstrap: BootstrapSetting = { worlds: [{ name: "Client", tags: ["client"] }, { name: "Lobby", tags: ["server"], scenes: [] }] };
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(bootstrap) });
    expect(engineWorld(play.engine, "Client")!.sceneNodes).toHaveLength(1);
    expect(engineWorld(play.engine, "Lobby")!.sceneNodes).toHaveLength(0);
    play.stop();
  });

  it("Stop disposes every World and resumes the editor", async () => {
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(CLIENT_SERVER) });
    const handles = play.engine.worlds();
    const managers = handles.map((h) => World._runIn(engineWorld(play.engine, h.name)!, () => GameObject.findObjectOfType(GameManager))!);
    for (let i = 0; i < 10; i++) play.engine.step(frame);
    play.stop();
    expect(handles.every((h) => !h.alive)).toBe(true);
    expect(managers.every((m) => !m.node.isValid)).toBe(true);
    expect(play.engine.worlds()).toEqual([]);
    expect(World.active).toBe(editor.world);
    expect(Assets.json(SCENE)).toBe(sample.assets.get(SCENE));
  });

  it("runs a code bootstrap from the project's loaded scripts", async () => {
    const source = `
      export function bootstrap(engine) {
        engine.createWorld({ name: "Server", tags: ["server"] });
        engine.createWorld({ name: "Client", tags: ["client"] });
      }
    `;
    const loaded = await replaceScripts(new Map([["scripts/Bootstrap.ts", source]]));
    expect(loaded.problems).toEqual([]);
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap("scripts/Bootstrap.ts") });
    expect(play.engine.worlds().map((w) => w.name)).toEqual(["Server", "Client"]);
    play.engine.step(frame);
    expect(birdX(play.engine, "Server")).toBe(birdX(play.engine, "Client"));
    play.stop();
  });

  it("reports a code bootstrap that isn't loaded, and resumes the editor", async () => {
    await expect(startPlay({ editor, scene: openScene.value!, project: withBootstrap("scripts/Missing.ts") })).rejects.toThrow(/scripts\/Missing\.ts.*isn't loaded/);
    expect(World.active).toBe(editor.world);
    expect(Assets.json(SCENE)).toBe(sample.assets.get(SCENE));
  });

  it("moves local input to a chosen World, except Worlds whose config sets input", async () => {
    const bootstrap: BootstrapSetting = {
      worlds: [
        { name: "P1", tags: ["client"] },
        { name: "P2", tags: ["client"] },
        { name: "Spectator", tags: ["client"], input: false },
      ],
    };
    const play = await startPlay({ editor, scene: openScene.value!, project: withBootstrap(bootstrap) });
    const input = () => worldViewStates(play.engine).filter((s) => s.takesInput).map((s) => s.name);
    expect(input()).toEqual(["P1"]);
    focusWorldInput(play.engine, "P2");
    expect(input()).toEqual(["P2"]);
    focusWorldInput(play.engine, "Spectator");
    expect(input()).toEqual([]); // its config says no
    focusWorldInput(play.engine, "P2");
    play.engine.findWorld("P2")!.destroy(); // input goes back to the main view's World
    expect(input()).toEqual(["P1"]);
    expect(() => focusWorldInput(play.engine, "Nobody")).toThrow(/no World named "Nobody"/);
    play.stop();
  });

  it("the editor's Engine keeps exactly one Editor World", () => {
    expect(editor.worlds().map((w) => [w.name, w.tags])).toEqual([["Editor", ["editor"]]]);
  });
});
