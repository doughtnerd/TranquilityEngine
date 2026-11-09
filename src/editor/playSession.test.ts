import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { engineWorld, listComponents, listNodes } from "../engine/editor";
import type { SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { createPlaySession, type PlayController } from "./playSession";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { keepComponent } from "./runtimeInspect";
import { replaceScripts } from "./scriptLoader";
import { currentProject, openScene, playing, playState, sceneCamera, scriptProblems, status } from "./state";
import { applyEditorPlugins } from "../plugins/editorPlugins";
import { ROOT, demoFolder, type MemoryFileSystem } from "./testing";

// The play session (ADR 0161) driven headless: what Play and Stop do, and the work deferred to Stop.

const wheel = (extra = "") => `
import { GameBehavior, behavior, field } from "myco";
@behavior("game.Wheel")
export class Wheel extends GameBehavior {
  @field(Number) speed = 1;
  ${extra}
}
`;

let fs: MemoryFileSystem;
let project: EditorProject;
let editor: Engine;
let play: PlayController;
/** The script check's answer for the next Play. */
let checkPasses = true;
const file = (path: string) => joinPath(ROOT, path);

beforeEach(async () => {
  Input.reset();
  checkPasses = true;
  fs = demoFolder();
  fs.files.set(file("scripts/Wheel.ts"), wheel());
  const scene = JSON.parse(fs.files.get(file("scenes/main.scene.json")) as string) as SceneFile;
  scene.nodes.push({ id: "wheel", name: "Wheel", components: [{ type: "engine.Transform" }, { type: "game.Wheel", data: { speed: 12 } }] });
  fs.files.set(file("scenes/main.scene.json"), JSON.stringify(scene));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  scriptProblems.value = (await replaceScripts(project.scripts)).problems;
  editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
  openSceneFile(editor, project.mainScene!);
  play = createPlaySession({ editor: () => editor, checkBeforePlay: async () => checkPasses });
});

afterEach(async () => {
  await play.stop({ discardQueued: true });
  editor.dispose();
  currentProject.value = null;
  applyEditorPlugins(undefined); // every first-party plugin on again
  await replaceScripts(new Map()); // the editor build's types again
});

/** The edited scene's Wheel component's field value (the Editor World's node). */
const editorValue = (field: string) =>
  listComponents(openScene.value!.sync.nodeFor("wheel")!).find((c) => c.type === "game.Wheel")?.fields.find((f) => f.name === field)?.value;

/** The running game's Wheel node. */
function liveWheel(): GameObject {
  const engine = playing.value!.engine;
  return listNodes(engineWorld(engine, engine.world.name)!).find((n) => n.name === "Wheel")!.node;
}

/** The test project with some of its settings changed. */
const withSettings = (changes: Partial<EditorProject["settings"]>) =>
  Object.defineProperty(Object.create(project), "settings", { value: { ...project.settings, ...changes } }) as EditorProject;

describe("playing and stopping (ADR 0022, 0161)", () => {
  it("plays the open scene and returns to edit on Stop", async () => {
    await play.start();
    expect(playState.value).toBe("playing");
    expect(playing.value?.path).toBe("scenes/main.scene.json");
    expect(status.value?.text).toMatch(/^Playing scenes\/main\.scene\.json\./);
    await play.stop();
    expect(playState.value).toBe("edit");
    expect(playing.value).toBeNull();
    expect(editor.isRunning).toBe(false); // headless: it wasn't running before Play
  });

  it("doesn't play when the script check says no", async () => {
    checkPasses = false;
    const states: string[] = [];
    const off = playState.subscribe((s) => states.push(s));
    await play.start();
    off();
    expect(states).toEqual(["edit"]);
    expect(playing.value).toBeNull();
  });

  it("returns to edit with the error when the game can't start", async () => {
    currentProject.value = withSettings({ bootstrap: "scripts/Missing.ts" });
    await play.start();
    expect(playState.value).toBe("edit");
    expect(playing.value).toBeNull();
    expect(status.value).toMatchObject({ kind: "error" });
    expect(status.value?.text).toMatch(/^Couldn't play scenes\/main\.scene\.json/);
    expect(status.value?.text).toMatch(/scripts\/Missing\.ts/);
    currentProject.value = project;
    await play.start(); // and Play works again
    expect(playState.value).toBe("playing");
  });
});

describe("work deferred to Stop", () => {
  it("a script edited during play swaps into the game, and the Editor World reloads it on Stop", async () => {
    const before = getComponentClass("game.Wheel");
    await play.start();
    fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 5;`));
    await play.reloadScripts();
    expect(status.value?.text).toMatch(/^Reloaded scripts into the running game: 1 component swapped/);
    expect(liveWheel().getBehavior(getComponentClass("game.Wheel") as never)).toBeTruthy(); // the game runs the new class
    expect(getComponentClass("game.Wheel")).not.toBe(before);
    expect(editorValue("power")).toBeUndefined(); // the Editor World keeps its nodes until Stop

    await play.stop();
    expect(editorValue("power")).toBe(5);
    expect(editorValue("speed")).toBe(12); // from the document
    expect(status.value?.text).toBe("Reloaded 1 script.");
  });

  it("a script edited while the game is starting reloads on Stop", async () => {
    const before = getComponentClass("game.Wheel");
    let reloading: Promise<void> | null = null;
    const off = playState.subscribe((s) => {
      if (s !== "starting") return;
      fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 5;`));
      reloading = play.reloadScripts();
    });
    await play.start();
    off();
    await reloading;
    expect(playState.value).toBe("playing");
    expect(getComponentClass("game.Wheel")).toBe(before); // the game keeps the code it started with
    await play.stop();
    expect(getComponentClass("game.Wheel")).not.toBe(before);
    expect(editorValue("power")).toBe(5);
  });

  it("plugin settings changed during play apply on Stop", async () => {
    await play.start();
    currentProject.value = withSettings({ plugins: { disabled: ["myco.sky"] } });
    play.reapplyPlugins();
    expect(status.value?.text).toBe("Plugin settings changed. They apply when you stop playing.");
    expect(getComponentClass("engine.Sky")).toBeDefined(); // the running game keeps its plugins
    await play.stop();
    expect(getComponentClass("engine.Sky")).toBeUndefined();
  });

  it("writes kept values first, as one undo step, then reloads", async () => {
    await play.start();
    const scene = openScene.value!;
    const live = liveWheel();
    (live.getBehavior(getComponentClass("game.Wheel") as never) as unknown as { speed: number }).speed = 40;
    const info = listComponents(live).find((c) => c.type === "game.Wheel")!;
    expect(keepComponent(scene, live, info)).toMatchObject({ path: ["wheel"], values: { speed: 40 } });
    fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 5;`));
    await play.reloadScripts();

    const said: string[] = [];
    const off = status.subscribe((s) => s && said.push(s.text));
    said.length = 0; // subscribing reports the current message
    await play.stop();
    off();
    expect(said).toEqual([expect.stringMatching(/^Kept play-mode changes: 1 field written to scenes\/main\.scene\.json/), "Reloaded 1 script."]);
    expect(scene.doc.fieldValue("wheel", "game.Wheel", "speed")).toBe(40);
    expect(editorValue("speed")).toBe(40); // the rebuilt node, from the document the kept values went into
    expect(scene.stack.undoLabel).toBe("Keep play-mode changes");
  });

  it("a project switch drops the queued work", async () => {
    const before = getComponentClass("game.Wheel");
    let reloading: Promise<void> | null = null;
    const off = playState.subscribe((s) => {
      if (s === "starting") reloading = play.reloadScripts();
    });
    fs.files.set(file("scripts/Wheel.ts"), wheel(`@field(Number) power = 5;`));
    await play.start();
    off();
    await reloading;
    await play.stop({ discardQueued: true });
    expect(playState.value).toBe("edit");
    expect(getComponentClass("game.Wheel")).toBe(before);
  });
});
