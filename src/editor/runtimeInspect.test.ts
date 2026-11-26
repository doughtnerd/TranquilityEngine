import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetRef, Color, Engine, GameBehavior, GameObject, Input, behavior, field, type BootstrapSetting, type ProjectSettingsInput } from "../engine";
import { engineWorld, listComponents, listNodes, writeField } from "../engine/editor";
import { insertNodes } from "./nodeInsertion";
import { AddComponent, RemoveNode, SetField } from "./document";
import { OrbitCamera } from "./OrbitCamera";
import { startPlay, type PlaySession } from "./playMode";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets, type EditorProject } from "./projects";
import { applyKept, docPathFor, forgetKept, keepComponent, keepNode, kept, liveRows, takeKept, type KeptValues } from "./runtimeInspect";
import { replaceScripts } from "./scriptLoader";
import { openScene, sceneCamera } from "./state";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds(); // core asset kinds, as main.tsx registers them (ADR 0143)

// Inspecting the running game (ADR 0022): mapping live nodes back to the edited document, "Keep
// values" written on Stop as one undo step, the live tree, and pausing and stepping the session.

/** Lists of each kind that holds live objects: node references, colors and asset paths. */
@behavior("test.runtimeInspect.Lists")
class Lists extends GameBehavior {
  @field([GameObject]) targets: (GameObject | null)[] = [];
  @field([Color]) tints: Color[] = [];
  @field([AssetRef]) images: string[] = [];
}

let editor: Engine;
let sample: EditorProject;
let play: PlaySession | null = null;
const frame = 1 / 60;
const SCENE = "scenes/main.scene.json";

function withBootstrap(bootstrap: BootstrapSetting): EditorProject {
  const settings: ProjectSettingsInput = { ...sample.settings, bootstrap };
  return Object.defineProperty(Object.create(sample), "settings", { value: settings }) as EditorProject;
}

/** The live node named `name` (searched by name below the played scene) in World `world`. */
function live(engine: Engine, name: string, world = engine.world.name): GameObject {
  const found = listNodes(engineWorld(engine, world)!).find((n) => n.name === name);
  if (!found) throw new Error(`no live node "${name}"`);
  return found.node;
}

const transformOf = (node: GameObject) => listComponents(node).find((c) => c.type === "engine.Transform")!;

beforeEach(async () => {
  Input.reset();
  sample = sampleProject();
  useProjectAssets(sample);
  editor = await Engine.create({ headless: true, kind: "editor", project: editorSettings(sample) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: editor.world.root }));
  openSceneFile(editor, sample.mainScene!);
  forgetKept();
});

afterEach(async () => {
  play?.stop();
  play = null;
  editor.dispose();
  await replaceScripts(new Map());
});

describe("mapping live nodes to the edited document", () => {
  it("maps scene nodes by id, and nodes inside a placed prefab instance as [instance, inner…]", async () => {
    const scene = openScene.value!;
    const made = insertNodes(scene, { kind: "assets", paths: ["prefabs/pipe-pair.prefab.json"] }, { kind: "into", key: null });
    const pipes = made.ok ? made.keys[0]! : "";
    play = await startPlay({ editor, scene, project: sample });
    const engine = play.engine;
    expect(docPathFor(live(engine, "Bird"), SCENE, scene.doc)).toEqual({ path: ["bird"] });
    expect(docPathFor(live(engine, "Bird").children[0], SCENE, scene.doc)).toEqual({ path: ["bird-sprite"] });
    const instance = engineWorld(engine, engine.world.name)!.sceneNodes[0].children.find((n) => n.id === pipes)!;
    expect(docPathFor(instance, SCENE, scene.doc)).toEqual({ path: [pipes] });
    expect(docPathFor(instance.find("Top")!, SCENE, scene.doc)).toEqual({ path: [pipes, "top"] });
  });

  it("says why nodes made at runtime, the scene itself and nodes deleted since Play don't map", async () => {
    const scene = openScene.value!;
    play = await startPlay({ editor, scene, project: sample });
    const engine = play.engine;
    const world = engineWorld(engine, engine.world.name)!;
    const sceneNode = world.sceneNodes[0];
    const made = GameObject.create("Made", { parent: sceneNode });
    const outside = GameObject.create("Outside", { parent: world.root });
    const pipe = GameObject.instantiate("prefabs/pipe-pair.prefab.json", { parent: sceneNode });
    const reason = (n: GameObject) => (docPathFor(n, SCENE, scene.doc) as { reason: string }).reason;
    expect(reason(made)).toMatch(/made at runtime/);
    expect(reason(outside)).toMatch(/outside any scene/);
    expect(reason(pipe)).toMatch(/instantiated at runtime from prefabs\/pipe-pair\.prefab\.json/);
    expect(reason(pipe.find("Top")!)).toMatch(/inside an instance instantiated at runtime/);
    expect(reason(sceneNode)).toMatch(/the scene itself/);
    expect(docPathFor(live(engine, "Bird"), "scenes/other.scene.json", scene.doc)).toEqual({ reason: expect.stringMatching(/from scenes\/main\.scene\.json, not the scene being edited/) });
    scene.stack.execute(new SetField("bird", "engine.Transform", "position", [0, 0, 0])); // still there
    expect(docPathFor(live(engine, "Bird"), SCENE, scene.doc)).toEqual({ path: ["bird"] });
  });
});

describe("the live tree", () => {
  it("lists a World's nodes below its root with what they are, and leaves out collapsed subtrees", async () => {
    play = await startPlay({ editor, scene: openScene.value!, project: sample });
    const world = engineWorld(play.engine, play.engine.world.name)!;
    const sceneNode = world.sceneNodes[0];
    GameObject.instantiate("prefabs/pipe-pair.prefab.json", { parent: sceneNode });
    const rows = liveRows(world);
    const sceneRow = rows.find((r) => r.node === sceneNode)!;
    expect(sceneRow).toMatchObject({ depth: 0, kind: "scene", badge: "main" });
    expect(rows.find((r) => r.name === "Bird")).toMatchObject({ depth: 1, kind: null });
    expect(rows.find((r) => r.name === "PipePair" || r.kind === "instance")).toMatchObject({ kind: "instance", badge: "pipe-pair" });
    const collapsed = liveRows(world, new Set([sceneNode.entity]));
    expect(collapsed.some((r) => r.node === sceneNode)).toBe(true);
    expect(collapsed.filter((r) => isUnder(r.node, sceneNode))).toEqual([]);
    expect(rows.filter((r) => isUnder(r.node, sceneNode)).length).toBeGreaterThan(5);
  });
});

function isUnder(node: GameObject, ancestor: GameObject): boolean {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

describe("keeping values from play mode", () => {
  it("writes kept values into the document on Stop as one undo step: plain fields on scene nodes, overrides on instances", async () => {
    const scene = openScene.value!;
    play = await startPlay({ editor, scene, project: sample });
    const engine = play.engine;
    const bird = live(engine, "Bird");
    const tile = engineWorld(engine, engine.world.name)!.sceneNodes[0].children.find((n) => n.id === "bg-a")!;
    // Move them in the live World (as the live Inspector would) and keep the values.
    writeField(bird, "engine.Transform", 0, "position", [-1.5, 2.25, 0]);
    writeField(tile, "engine.Transform", 0, "position", [4, 3, 0]);
    expect(keepComponent(scene, bird, transformOf(bird))).toMatchObject({ path: ["bird"], type: "engine.Transform", values: { position: [-1.5, 2.25, 0] } });
    expect(keepComponent(scene, tile, transformOf(tile))).toMatchObject({ path: ["bg-a"] });
    expect(kept.value.size).toBe(2);
    // Keeping again replaces the entry with the newer values.
    writeField(bird, "engine.Transform", 0, "position", [-1, 2, 0]);
    keepComponent(scene, bird, transformOf(bird));
    expect(kept.value.size).toBe(2);

    const list = takeKept();
    play.stop();
    play = null;
    const before = scene.stack.undoLabel;
    const result = applyKept(scene, list);
    expect(result).toEqual({ written: 2, skipped: [] });
    expect(scene.doc.fieldValue("bird", "engine.Transform", "position")).toEqual([-1, 2, 0]);
    expect(scene.doc.node("bg-a").overrides).toContainEqual({ component: "engine.Transform", field: "position", value: [4, 3, 0] });
    expect(scene.stack.undoLabel).toBe("Keep play-mode changes");
    scene.stack.undo();
    expect(scene.stack.undoLabel).toBe(before);
    expect(scene.doc.fieldValue("bird", "engine.Transform", "position")).not.toEqual([-1, 2, 0]);
    expect(scene.doc.node("bg-a").overrides ?? []).not.toContainEqual(expect.objectContaining({ value: [4, 3, 0] }));
  });

  it("keeps every component of a node, writes only what changed, and skips nodes deleted meanwhile", async () => {
    const scene = openScene.value!;
    play = await startPlay({ editor, scene, project: sample });
    const engine = play.engine;
    for (let i = 0; i < 5; i++) engine.step(frame);
    const manager = live(engine, "GameManager");
    const text = listComponents(manager).find((c) => c.type === "game.GameManager")!;
    writeField(manager, "game.GameManager", 0, "restartDelay", 99);
    expect(keepNode(scene, manager)).toBe(listComponents(manager).length);
    const sprite = live(engine, "Bird").children[0];
    keepComponent(scene, sprite, listComponents(sprite).find((c) => c.type === "engine.SpriteRenderer")!);
    expect(text).toBeDefined();
    const list = takeKept();
    play.stop();
    play = null;
    // The bird's sprite is deleted from the document before Stop is handled.
    scene.stack.execute(new RemoveNode("bird-sprite"));
    const result = applyKept(scene, list);
    expect(scene.doc.fieldValue("game", "game.GameManager", "restartDelay")).toBe(99);
    // Nothing else on the node changed, so nothing else is written.
    expect(result.written).toBe(1);
    expect(result.skipped).toEqual([expect.stringMatching(/^Sprite › SpriteRenderer: the node isn't in the scene any more/)]);
  });

  it("keeps lists of nodes, colors and assets in scene-file form, and writes nothing when they didn't change", async () => {
    const scene = openScene.value!;
    const values = { targets: [{ $node: "bird" }, null], tints: ["#ff0000", "#00ff0080"], images: ["asset:images/flappyBird.png"] };
    scene.stack.execute(new AddComponent("spawner", { type: "test.runtimeInspect.Lists", data: values }));
    play = await startPlay({ editor, scene, project: sample });
    const spawner = live(play.engine, "PipeSpawner");
    const lists = () => listComponents(spawner).find((c) => c.type === "test.runtimeInspect.Lists")!;
    expect(spawner.getBehavior(Lists)!.targets[0]).toBeInstanceOf(GameObject);
    const entry = keepComponent(scene, spawner, lists());
    expect(entry).toMatchObject({ values });
    // Unchanged in play: nothing to write on Stop.
    expect(applyKept(scene, [entry as KeptValues])).toEqual({ written: 0, skipped: [] });
    // A changed list is written in scene-file form.
    writeField(spawner, "test.runtimeInspect.Lists", 0, "tints", ["#0000ff"]);
    const changed = keepComponent(scene, spawner, lists()) as KeptValues;
    play.stop();
    play = null;
    expect(applyKept(scene, [changed])).toEqual({ written: 1, skipped: [] });
    expect(scene.doc.fieldValue("spawner", "test.runtimeInspect.Lists", "tints")).toEqual(["#0000ff"]);
    expect(scene.doc.fieldValue("spawner", "test.runtimeInspect.Lists", "targets")).toEqual(values.targets);
  });

  it("refuses nodes that don't map, with the reason", async () => {
    const scene = openScene.value!;
    play = await startPlay({ editor, scene, project: sample });
    const world = engineWorld(play.engine, play.engine.world.name)!;
    const pipe = GameObject.instantiate("prefabs/pipe-pair.prefab.json", { parent: world.sceneNodes[0] });
    expect(keepComponent(scene, pipe, transformOf(pipe))).toMatch(/instantiated at runtime/);
    expect(keepNode(scene, pipe)).toMatch(/instantiated at runtime/);
    expect(kept.value.size).toBe(0);
  });
});

describe("pausing and stepping the play session", () => {
  it("steps every World one frame, with a fixed step when due; stepWorld steps one World, paused or not", async () => {
    play = await startPlay({
      editor,
      scene: openScene.value!,
      project: withBootstrap({ worlds: [{ name: "Fast", tags: ["client"] }, { name: "Slow", tags: ["server"], tickRate: 30 }] }),
    });
    const fast = engineWorld(play.engine, "Fast")!, slow = engineWorld(play.engine, "Slow")!;
    const counts = () => [fast.time.frameCount, slow.time.frameCount, fast.time.fixedStepCount, slow.time.fixedStepCount];
    expect(play.paused).toBe(false);
    const [f0, s0, ff0, sf0] = counts();
    play.step();
    expect(play.paused).toBe(true);
    play.step();
    const [f1, s1, ff1, sf1] = counts();
    expect([f1 - f0, s1 - s0]).toEqual([2, 2]);
    expect(ff1 - ff0).toBeGreaterThanOrEqual(1); // 60 Hz: about one per step
    expect(sf1 - sf0).toBeLessThanOrEqual(1); // 30 Hz: one every other step
    play.engine.findWorld("Slow")!.pause();
    play.stepWorld("Slow");
    play.step(); // a paused World sits out the session's step
    const [f2, s2] = counts();
    expect([f2 - f1, s2 - s1]).toEqual([1, 1]);
    play.setPaused(false);
    expect(play.paused).toBe(false);
  });
});

