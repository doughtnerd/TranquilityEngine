// Bones in the editor (ADR 0373, 0242; T18): a node with a Skeleton lists its skeleton asset's bones in the Hierarchy
// (through the plugin's `registerSkeletonBones` contribution, as the Hierarchy reads it), selecting one makes the
// Inspector's target that bone, the bone's details come from the asset, Add BoneAttachment adds a child following it as
// one undo step, and the scene view draws the selected bone's axes. Fixture: `runtime/wasm/fixtures/small.skel`.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets, Engine, GameObject, Input } from "../../../../myco";
import { inspectorTarget, select, selectBone, showSceneSettings } from "../../../../editor/inspectorTarget";
import { OrbitCamera } from "../../../../editor/OrbitCamera";
import { editorSettings, useProjectAssets } from "../../../../editor/projects";
import { skeletonBones, type SkeletonBoneRow } from "../../../../editor/sdk/contributions";
import { openSceneFile } from "../../../../editor/sceneTabs";
import { openScene, playState, sceneCamera, status, type OpenScene } from "../../../../editor/state";
import { closeTestProject, openTestProject, sceneViewTools } from "../../../../editor/testing";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { animationEditorPlugin } from "..";
import { addBoneAttachment, boneDetails } from "./bones";
import { loadSkeletonInfo } from "./skeletonAssets";

const plugins = useEditorPlugins([animationEditorPlugin]);

const SKEL = new Uint8Array(readFileSync(new URL("../../runtime/wasm/fixtures/small.skel", import.meta.url)));
const dataUrl = (bytes: Uint8Array) => `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;

const SCENE = {
  format: "myco.scene@4",
  nodes: [
    { id: "rig", name: "Rig", components: [{ type: "engine.Transform", data: { position: [1, 0, 0] } }, { type: "engine.Skeleton", data: { skeleton: "asset:rigs/small.skel" } }] },
    { id: "prop", name: "Prop", components: [{ type: "engine.Transform", data: {} }] },
  ],
};

let engine: Engine;
let scene: OpenScene;

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  const { project } = await openTestProject({ "scenes/main.scene.json": JSON.stringify(SCENE) });
  useProjectAssets(project);
  // The skeleton's bytes, served as the project's binary files are (by URL).
  Assets.addSource(Assets.fromObject({ "rigs/small.skel": dataUrl(SKEL) }));
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  scene = openScene.value!;
  await loadSkeletonInfo("asset:rigs/small.skel");
});

afterEach(() => {
  showSceneSettings();
  sceneCamera.value = null;
  engine.dispose();
  closeTestProject();
});

const contribution = () => skeletonBones.list().find((c) => c.id === "myco.animation.bones")!;
const names = (rows: readonly SkeletonBoneRow[]): unknown => rows.map((r) => (r.children.length ? { [r.name]: names(r.children) } : r.name));

describe("bones in the Hierarchy (ADR 0373)", () => {
  it("lists a Skeleton's bones as a tree from its asset, and none for a node without one", () => {
    expect(names(contribution().bones(scene, ["rig"]))).toEqual([
      { bone0: [{ bone1: ["bone5"] }, { bone2: [{ bone3: ["bone4", { bone7: ["bone8", { bone9: ["bone10", "bone11"] }] }] }, "bone6"] }] },
    ]);
    expect(contribution().bones(scene, ["prop"])).toEqual([]);
  });

  it("goes away with the plugin's editor half", () => {
    expect(skeletonBones.get("myco.animation.bones")).toBeDefined();
    plugins.off();
    expect(skeletonBones.get("myco.animation.bones")).toBeUndefined();
    plugins.on();
  });
});

describe("the Inspector's bone target (ADR 0242, 0373)", () => {
  it("selecting a bone makes it the target; selecting a node or the scene settings replaces it", () => {
    select(["prop"]);
    selectBone(scene, ["rig"], "bone3", "myco.animation.bones");
    expect(inspectorTarget.value).toMatchObject({ kind: "bone", path: ["rig"], bone: "bone3", provider: "myco.animation.bones" });
    select(["prop"]);
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [["prop"]] });
    selectBone(scene, ["rig"], "bone3", "myco.animation.bones");
    showSceneSettings();
    expect(inspectorTarget.value.kind).toBe("sceneSettings");
  });

  it("shows the bone's name, parent, children and rest pose from the asset, and its model-space pose at rest", () => {
    const d = boneDetails(scene, ["rig"], "bone3")!;
    expect(d).toMatchObject({ name: "bone3", parent: "bone2", children: 2, animated: false });
    d.rest.position.forEach((v, i) => expect(v).toBeCloseTo([-0.077, 0.145, 0.1][i]!, 3));
    expect(Math.hypot(...d.rest.rotation)).toBeCloseTo(1, 4);
    expect(d.pose.scale.map((s) => +s.toFixed(4))).toEqual([1, 1, 1]);
    expect(boneDetails(scene, ["rig"], "bone0")!.parent).toBeNull();
    expect(boneDetails(scene, ["rig"], "nope")).toBeNull();
    expect(boneDetails(scene, ["prop"], "bone0")).toBeNull();
  });

  it("Add BoneAttachment adds a child following the bone as one undo step, and selects it", () => {
    const key = addBoneAttachment(scene, ["rig"], "bone7");
    expect(key).not.toBeNull();
    const entry = scene.doc.node(key!);
    expect(entry.name).toBe("bone7");
    expect(scene.doc.children("rig")).toContain(key);
    expect(entry.components?.find((c) => c.type === "engine.BoneAttachment")?.data).toEqual({ bone: "bone7" });
    expect(inspectorTarget.value).toMatchObject({ kind: "nodes", paths: [[key]] });
    expect(scene.stack.undoLabel).toBe("Add BoneAttachment for bone7");
    scene.stack.undo();
    expect(scene.doc.has(key!)).toBe(false);
  });

  it("refuses Add BoneAttachment while playing, with the reason in the log", () => {
    playState.value = "playing";
    expect(addBoneAttachment(scene, ["rig"], "bone7")).toBeNull();
    expect(status.value?.text).toMatch(/Can.t add BoneAttachment for bone7: stop playing/);
    playState.value = "edit";
  });
});

describe("the bone gizmo (ADR 0373)", () => {
  it("draws the selected bone's three axes at its world position, and nothing otherwise", () => {
    const tools = sceneViewTools(engine);
    try {
      const boneLines = () => tools.overlay().lines.filter((l) => [0xe5484d, 0x46a758, 0x3e63dd].includes(l.color));
      expect(boneLines()).toEqual([]);
      selectBone(scene, ["rig"], "bone0", "myco.animation.bones");
      const lines = boneLines();
      expect(lines).toHaveLength(3);
      // bone0's rest translation is the origin; the Rig node sits at x = 1.
      for (const l of lines) l.points[0]!.forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0][i]!, 4));
      select([]);
      expect(boneLines()).toEqual([]);
    } finally {
      tools.stop();
    }
  });
});
