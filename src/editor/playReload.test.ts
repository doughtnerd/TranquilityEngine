import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input, getComponentClass } from "../engine";
import { World } from "../engine/core/World";
import { captureScriptTypes, engineWorld, swapScriptTypes } from "../engine/editor";
import type { SceneFile } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay, type PlaySession } from "./playMode";
import { openSceneFile } from "./project";
import { editorSettings, joinPath, openFolderProject, useProjectAssets, type EditorProject } from "./projects";
import { loadedRegistrations, replaceScripts } from "./scriptLoader";
import { openScene, sceneCamera } from "./state";
import { ROOT, demoFolder, type MemoryFileSystem } from "./testing";

/** A script with a behavior, a helper it references, a data component and a system; `v` sets what changes between versions. */
const counter = (v: { gain: number; extra?: string; speedFields?: string; speedUp?: number }) => `
import { GameBehavior, behavior, field, defineComponent, defineSystem, f32 } from "myco";

export const Speed = defineComponent("game.Speed", { v: f32${v.speedFields ?? ""} });

defineSystem({
  name: "game.SpeedUp",
  phase: "update",
  query: [Speed],
  run(rows) {
    for (const row of rows) (row.speed as { v: number }).v += ${v.speedUp ?? 1};
  },
});

@behavior("game.Helper")
export class Helper extends GameBehavior {
  owner: Counter | null = null;
}

@behavior("game.Counter")
export class Counter extends GameBehavior {
  static instance: Counter | null = null;
  @field(Number) step = 1;
  count = 0;
  log: string[] = [];
  helpers: Helper[] = [];
  ${v.extra ?? ""}
  awake(): void {
    Counter.instance = this;
    this.log.push("awake");
    const helper = this.node.getBehavior(Helper)!;
    helper.owner = this;
    this.helpers.push(helper);
    this.node.addData(Speed, { v: 10 });
  }
  start(): void {
    this.log.push("start");
  }
  onEnable(): void {
    this.log.push("enable");
  }
  onDisable(): void {
    this.log.push("disable");
  }
  update(): void {
    this.count += this.step * ${v.gain};
  }
}
`;

let fs: MemoryFileSystem;
let project: EditorProject;
let editor: Engine;
let play: PlaySession | null = null;
const file = (path: string) => joinPath(ROOT, path);
const frame = 1 / 60;

interface CounterLike {
  step: number;
  count: number;
  log: string[];
  helpers: { owner: unknown }[];
  bonus?: number;
  node: GameObject;
}

/** The Counter in the game's World, and its class's `instance`. */
function counterIn(engine: Engine): { counter: CounterLike; instance: unknown } {
  const world = engineWorld(engine, engine.world.name)!;
  const cls = getComponentClass("game.Counter")!;
  const counter = World._runIn(world, () => GameObject.findObjectOfType(cls as never)) as unknown as CounterLike;
  return { counter, instance: (cls as unknown as { instance: unknown }).instance };
}

beforeEach(async () => {
  Input.reset();
  fs = demoFolder();
  fs.files.set(file("scripts/Counter.ts"), counter({ gain: 1 }));
  const scene = JSON.parse(fs.files.get(file("scenes/main.scene.json")) as string) as SceneFile;
  scene.nodes.push({ id: "counter", name: "Counter", components: [{ type: "engine.Transform" }, { type: "game.Helper" }, { type: "game.Counter", data: { step: 2 } }] });
  fs.files.set(file("scenes/main.scene.json"), JSON.stringify(scene));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  const result = await replaceScripts(project.scripts);
  expect(result.problems).toEqual([]);
  editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
  openSceneFile(editor, project.mainScene!);
  play = await startPlay({ editor, scene: openScene.value!, project });
  for (let i = 0; i < 3; i++) play.engine.step(frame);
});

afterEach(async () => {
  play?.stop();
  play = null;
  editor.dispose();
  await replaceScripts(new Map());
});

/** Save a new version of the script and reload it into the running game, as the session does. */
async function reloadWith(source: string) {
  fs.files.set(file("scripts/Counter.ts"), source);
  await project.rereadScripts();
  const before = captureScriptTypes(loadedRegistrations());
  const result = await replaceScripts(project.scripts);
  return { result, swap: swapScriptTypes(play!.engine, before) };
}

describe("reloading scripts into a running game (ADR 0125)", () => {
  it("swaps behaviors to the new class, keeping every property and skipping awake and start", async () => {
    const { counter: old } = counterIn(play!.engine);
    expect(old.count).toBe(6); // 3 frames × step 2
    expect(old.log).toEqual(["awake", "enable", "start"]);

    const { swap, result } = await reloadWith(counter({ gain: 10, extra: "@field(Number) bonus = 7;" }));
    expect(result.problems).toEqual([]);
    expect(swap.swapped).toBe(2); // the Counter and its Helper
    const { counter: now, instance } = counterIn(play!.engine);
    expect(now).not.toBe(old);
    expect(now).toBeInstanceOf(getComponentClass("game.Counter") as never);
    expect(now.count).toBe(6);
    expect(now.step).toBe(2); // a @field
    expect(now.bonus).toBe(7); // a new field: its default
    expect(now.log).toEqual(["awake", "enable", "start", "disable", "enable"]); // the old instance's array, carried over
    expect(instance).toBe(now); // static instance re-pointed
    expect(now.helpers[0].owner).toBe(now); // references between swapped components re-pointed
    expect(now.helpers[0]).toBeInstanceOf(getComponentClass("game.Helper") as never);
    expect(now.node.getBehavior(getComponentClass("game.Counter") as never)).toBe(now);

    play!.engine.step(frame);
    expect(now.count).toBe(26); // the new update: step 2 × gain 10
    expect(old.count).toBe(6); // the old instance no longer runs
  });

  it("moves data component rows to the new definition, and systems run their new code", async () => {
    const speed = () => {
      const { counter: c } = counterIn(play!.engine);
      const def = c.node.world._dataComponentsOf(c.node.entity).find((d) => d.id === "game.Speed")!;
      return c.node.getData(def) as unknown as { v: number; w?: number };
    };
    expect(speed().v).toBe(13); // 10, plus 1 a frame
    await reloadWith(counter({ gain: 1, speedFields: ", w: f32", speedUp: 100 }));
    expect(speed()).toMatchObject({ v: 13, w: 0 });
    play!.engine.step(frame);
    expect(speed().v).toBe(113);
  });

  it("keeps the old code running for a script that fails to load", async () => {
    const { counter: old } = counterIn(play!.engine);
    const { result, swap } = await reloadWith("export class = ;");
    expect(result.problems.map((p) => p.path)).toEqual(["scripts/Counter.ts"]);
    expect(swap.swapped).toBe(0);
    expect([...swap.kept].sort()).toEqual(["game.Counter", "game.Helper"]);
    play!.engine.step(frame);
    expect(old.count).toBe(8);
  });
});
