// Dropping a skinned model (ADR 0373 "Drop behaviour"; T18): through the editor's own add (`addAssets`, as a drop on the
// scene view or the Hierarchy does), the Meshes plugin's model nodes are augmented by the Animation plugin through the
// `modelNodeAugments` contribution point. A model whose meshes carry a skin (D105 `ModelMesh.skin`; the fixture's meshes
// are given one, as the importer T14 will fill it) gets a Skeleton, SkinnedMeshRenderers and an Animator playing its first
// clip, in one undo step; a static model is untouched; deactivating the Animation plugin removes the augment.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../../myco";
import { addAssets } from "../../../../editor/addAssets";
import { activatePlugin, deactivatePlugin } from "../../../../editor/sdk/plugins";
import type { NodeEntry } from "../../../../editor/document";
import { OrbitCamera } from "../../../../editor/OrbitCamera";
import { editorSettings, useProjectAssets } from "../../../../editor/projects";
import { openSceneFile } from "../../../../editor/sceneTabs";
import { openScene, playState, sceneCamera, type OpenScene } from "../../../../editor/state";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { loadModel } from "../../../../engine/scene/models";
import { carGltf, dataUrl } from "../../../../engine/tests/fixtures/gltf/carGltf";
import { meshesEditorPlugin } from "../../../meshes/editor";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { animationEditorPlugin } from "..";

const plugins = useEditorPlugins([meshesEditorPlugin, animationEditorPlugin]);

const CAR = dataUrl(new TextEncoder().encode(JSON.stringify(carGltf())));
const SKIN = { influences: 4, joints: [0, 0, 0, 0], weights: [1, 0, 0, 0] };

let engine: Engine;
let scene: OpenScene;

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  const { project } = await openTestProject({ "scenes/main.scene.json": JSON.stringify({ format: "myco.scene@4", nodes: [] }) });
  useProjectAssets(project);
  Assets.addSource(Assets.fromObject({ "models/hero.gltf": CAR, "models/crate.gltf": CAR, "models/noclips.gltf": CAR }));
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  scene = openScene.value!;
});

afterEach(() => {
  sceneCamera.value = null;
  engine.dispose();
  closeTestProject();
});

/** Load `path` and give its `skinned` meshes a skin and the model `clips`, as the importer (T14) will. */
async function skinModel(path: string, skinned: readonly string[], clips?: readonly string[]): Promise<void> {
  const model = await loadModel(path);
  for (const mesh of model.meshes) if (skinned.includes(mesh.name)) Object.assign(mesh, { skin: SKIN });
  if (clips) Object.assign(model, { clips });
}

/** Drop `path` on the scene view at the origin; the added root's subtree, by name. */
async function drop(path: string): Promise<Map<string, NodeEntry>> {
  const { ids, message } = await addAssets([path], { kind: "point", position: [0, 0, 0] });
  expect(ids, message.text).toHaveLength(1);
  const out = new Map<string, NodeEntry>();
  const visit = (id: string) => {
    const node = scene.doc.node(id);
    out.set(node.name ?? id, node);
    for (const c of scene.doc.children(id)) visit(c);
  };
  visit(ids[0]!);
  return out;
}

const types = (node: NodeEntry | undefined) => node?.components?.map((c) => c.type) ?? [];
const data = (node: NodeEntry | undefined, type: string) => node?.components?.find((c) => c.type === type)?.data;

describe("dropping a skinned model (ADR 0373)", () => {
  it("adds a Skeleton and an Animator playing the first clip on the root, and SkinnedMeshRenderers for skinned meshes", async () => {
    await skinModel("models/hero.gltf", ["Body"], ["Run", "Idle"]);
    const nodes = await drop("models/hero.gltf");
    const root = nodes.get("Hero")!;
    expect(data(root, "engine.Skeleton")).toEqual({ skeleton: "asset:models/hero.gltf#Skeleton" });
    expect(data(root, "engine.Animator")).toEqual({ defaultClip: "asset:models/hero.gltf#Anim/Run" });
    expect(types(nodes.get("Body"))).toEqual(["engine.Transform", "engine.SkinnedMeshRenderer"]);
    expect(data(nodes.get("Body"), "engine.SkinnedMeshRenderer")).toEqual({ mesh: "asset:models/hero.gltf#Body#model" });
    expect(types(nodes.get("Wheel"))).toEqual(["engine.Transform", "engine.MeshRenderer"]); // no skin: a MeshRenderer still
  });

  it("is one undo step", async () => {
    await skinModel("models/hero.gltf", ["Body"], ["Run"]);
    const before = scene.doc.roots().length;
    await drop("models/hero.gltf");
    expect(scene.doc.roots().length).toBe(before + 1);
    scene.stack.undo();
    expect(scene.doc.roots().length).toBe(before);
  });

  it("adds an Animator with no default clip when the model has no clips", async () => {
    await skinModel("models/noclips.gltf", ["Body", "Wheel"]);
    const nodes = await drop("models/noclips.gltf");
    expect(data(nodes.get("Noclips"), "engine.Animator")).toEqual({});
    expect(types(nodes.get("Wheel"))).toContain("engine.SkinnedMeshRenderer");
  });

  it("leaves a model without skins as the Meshes plugin makes it", async () => {
    const nodes = await drop("models/crate.gltf");
    const all = [...nodes.values()].flatMap(types);
    expect(all).not.toContain("engine.Skeleton");
    expect(all).not.toContain("engine.Animator");
    expect(all).not.toContain("engine.SkinnedMeshRenderer");
    expect(all.filter((t) => t === "engine.MeshRenderer")).toHaveLength(2);
  });

  it("stops augmenting once the Animation plugin is off", async () => {
    await skinModel("models/hero.gltf", ["Body"], ["Run"]);
    plugins.off();
    activatePlugin(meshesEditorPlugin); // the Meshes plugin alone
    try {
      const nodes = await drop("models/hero.gltf");
      expect([...nodes.values()].flatMap(types)).not.toContain("engine.Skeleton");
    } finally {
      deactivatePlugin(meshesEditorPlugin.manifest.name);
      plugins.on();
    }
  });
});
