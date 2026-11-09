// ADR 0149: adding assets to a scene is one operation. It prepares, refuses without an editable open scene,
// adds to the scene it was asked for or to none, nests under the selection, makes one undo step, and takes
// refusals and notes from the assets' kinds.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { addAssets, whyNotAddAssets } from "./addAssets";
import { uniqueId } from "./assetNodes";
import { messageLog } from "./messages";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { editorSettings, useProjectAssets } from "./projects";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { openScene, playState, sceneCamera } from "./state";
import { sampleProject, useCoreAssetKinds } from "./testing";

useCoreAssetKinds();

let engine: Engine;
const undo: (() => void)[] = [];

/** A fake kind whose `prepare` waits until the test lets it finish. */
function slowKind(extra: Partial<NonNullable<AssetKindContribution["addToScene"]>> = {}) {
  let finish!: () => void;
  const prepared = new Promise<void>((resolve) => (finish = resolve));
  const prepares: string[] = [];
  const kind: AssetKindContribution = {
    id: "slow",
    extensions: [".slow.json"],
    label: "Slow",
    icon: "M0 0",
    addToScene: {
      prepare: (path) => (prepares.push(path), prepared),
      nodes: (doc, path, position = [0, 0, 0]) => [{ id: uniqueId(doc, "slow"), name: path, components: [{ type: "engine.Transform", data: { position: [...position] } }] }],
      ...extra,
    },
  };
  undo.push(assetKinds.register(kind));
  return { finish, prepares };
}

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  const project = sampleProject();
  useProjectAssets(project);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, project.mainScene!);
});

afterEach(() => {
  undo.splice(0).forEach((u) => u());
  playState.value = "edit";
  engine.dispose();
});

describe("adding assets as one operation (ADR 0149)", () => {
  it("prepares first, then adds, returning the ids to select and a message naming the scene", async () => {
    const slow = slowKind();
    const scene = openScene.value!;
    const adding = addAssets(["a.slow.json"], { kind: "slot", parent: null });
    await Promise.resolve();
    expect(slow.prepares).toEqual(["a.slow.json"]);
    expect(scene.doc.has("slow")).toBe(false); // not before it has prepared
    slow.finish();
    const { ids, message } = await adding;
    expect(ids).toEqual(["slow"]);
    expect(scene.doc.has("slow")).toBe(true);
    expect(message).toEqual({ kind: "info", text: "Added a.slow.json to main.scene.json" });
  });

  it("adds nothing when the open scene changes while the assets prepare (a tab switch)", async () => {
    const slow = slowKind();
    const first = openScene.value!;
    const adding = addAssets(["a.slow.json"], { kind: "slot", parent: null });
    openSceneFile(engine, "prefabs/pipe-pair.prefab.json"); // another tab comes forward
    const second = openScene.value!;
    slow.finish();
    const { ids, message } = await adding;
    expect(ids).toEqual([]);
    expect(message.text).toMatch(/main\.scene\.json is no longer the open scene/);
    expect(first.doc.has("slow")).toBe(false);
    expect(second.doc.has("slow")).toBe(false);
  });

  it("refuses without an open scene and while playing, also when play starts during the prepare", async () => {
    expect(whyNotAddAssets(["images/bird.png"], null)).toBe("Open a scene first");
    playState.value = "playing";
    expect((await addAssets(["images/bird.png"], { kind: "slot", parent: null })).message.text).toBe("Couldn't add bird.png: Stop playing to add assets");
    playState.value = "edit";

    const slow = slowKind();
    const scene = openScene.value!;
    const adding = addAssets(["a.slow.json"], { kind: "slot", parent: null });
    playState.value = "starting";
    slow.finish();
    expect((await adding).ids).toEqual([]);
    expect(scene.doc.has("slow")).toBe(false);
  });

  it("nests under the selected node, or beside a selected prefab instance, at the given position", async () => {
    const scene = openScene.value!;
    const under = await addAssets(["images/bird.png"], { kind: "selection", selected: "bird", position: [3, 1, 0] });
    expect(scene.doc.parentOf(under.ids[0]!)).toBe("bird");
    expect(scene.doc.node(under.ids[0]!).components![0]!.data).toEqual({ position: [3, 1, 0] });
    const beside = await addAssets(["music/town.mp3"], { kind: "selection", selected: "bg-a", position: [0, 0, 0] });
    expect(scene.doc.parentOf(beside.ids[0]!)).toBeNull();
    // Prefab instances keep their own position from the +; a scene-view drop places them.
    const kept = await addAssets(["prefabs/pipe-pair.prefab.json"], { kind: "selection", selected: null, position: [5, 5, 0] });
    expect(scene.doc.node(kept.ids[0]!).overrides).toBeUndefined();
    const placed = await addAssets(["prefabs/pipe-pair.prefab.json"], { kind: "point", position: [5, 5, 0] });
    expect(scene.doc.node(placed.ids[0]!).overrides).toEqual([{ component: "engine.Transform", field: "position", value: [5, 5, 0] }]);
  });

  it("adds several assets in a row at a Hierarchy slot as one undo step", async () => {
    const scene = openScene.value!;
    const at = scene.doc.roots().indexOf("ceiling");
    const { ids, message } = await addAssets(["images/bird.png", "music/town.mp3"], { kind: "slot", parent: null, index: at });
    expect(message.text).toBe("Added 2 assets to main.scene.json");
    expect(scene.doc.roots().slice(at, at + 3)).toEqual([...ids, "ceiling"]);
    scene.stack.undo();
    expect(ids.some((id) => scene.doc.has(id))).toBe(false);
    expect(scene.doc.roots().indexOf("ceiling")).toBe(at);
  });

  it("takes refusals and notes from the asset's kind", async () => {
    const slow = slowKind({ whyNot: (_doc, path) => (path.startsWith("no") ? "it says no" : null), note: (path, entries) => `${entries.length} node for ${path}` });
    expect(whyNotAddAssets(["no.slow.json"])).toBe("it says no");
    expect(whyNotAddAssets(["images/bird.png", "no.slow.json"])).toBe("no.slow.json: it says no");
    expect(whyNotAddAssets(["scenes/main.scene.json"])).toMatch(/inside itself/); // the core scene kind's refusal
    expect(whyNotAddAssets(["images/"])).toMatch(/folders/);
    expect(whyNotAddAssets(["project.json"])).toMatch(/no kind of scene node fits/);
    expect((await addAssets(["no.slow.json"], { kind: "slot", parent: null })).message.text).toBe("Couldn't add no.slow.json: it says no");
    const before = messageLog.value.length;
    const adding = addAssets(["yes.slow.json"], { kind: "slot", parent: null });
    slow.finish();
    expect((await adding).ids).toEqual(["slow"]);
    expect(messageLog.value.slice(before).map((m) => m.text)).toContain("yes.slow.json: 1 node for yes.slow.json");
  });
});
