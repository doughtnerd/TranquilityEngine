// Dropping a clip on an Animator (ADR 0373 "Drop behaviour"; T18), through the plugin's node drop contribution as the
// Hierarchy's asset drag asks it (`registerNodeAssetDrop`): without a graph it sets the default clip, or replaces it, as
// one undo step; with a graph, or when the Animator already plays the clip, it's refused (refused-or-next, ADR 0307) with
// the reason in the status bar; files that aren't one clip, and nodes without an Animator, aren't taken (they add as
// usual). The Animator's Inspector card gets the drop zone section.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../../../../myco";
import { OrbitCamera } from "../../../../editor/OrbitCamera";
import { editorSettings, useProjectAssets } from "../../../../editor/projects";
import { nodeAssetDrops } from "../../../../editor/sdk/contributions";
import { openSceneFile } from "../../../../editor/sceneTabs";
import { openScene, playState, sceneCamera, status, type OpenScene } from "../../../../editor/state";
import { closeTestProject, inspectorSectionsFor, openTestProject } from "../../../../editor/testing";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { animationEditorPlugin } from "..";

useEditorPlugins([animationEditorPlugin]);

const animator = (data: Record<string, unknown>) => [{ type: "engine.Transform", data: {} }, { type: "engine.Animator", data }];
const SCENE = {
  format: "myco.scene@4",
  nodes: [
    { id: "empty", name: "Empty", components: animator({}) },
    { id: "idle", name: "Idler", components: animator({ defaultClip: "asset:animation/idle.anim.json" }) },
    { id: "graph", name: "Graphed", components: animator({ graph: "asset:animation/loco.animgraph.json" }) },
    { id: "plain", name: "Plain", components: [{ type: "engine.Transform", data: {} }] },
  ],
};

let engine: Engine;
let scene: OpenScene;

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  const { project } = await openTestProject({ "scenes/main.scene.json": JSON.stringify(SCENE) });
  useProjectAssets(project);
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

const contribution = () => nodeAssetDrops.get("myco.animation.clipOnAnimator")!;
const label = (node: string, assets: readonly string[]) => contribution().label(scene, [node], assets);
const defaultClip = (node: string) => scene.doc.fieldValue(node, "engine.Animator", "defaultClip");

describe("dropping a clip on an Animator (ADR 0373)", () => {
  it("sets the default clip of an Animator without one, as one undo step", () => {
    expect(label("empty", ["animation/run.anim.json"])).toBe("Set run as Empty's default clip");
    contribution().drop(scene, ["empty"], ["animation/run.anim.json"]);
    expect(defaultClip("empty")).toBe("asset:animation/run.anim.json");
    expect(scene.stack.undoLabel).toBe("Set run as Empty's default clip");
    scene.stack.undo();
    expect(defaultClip("empty")).toBeUndefined();
  });

  it("replaces the default clip of an Animator that has one (the implicit graph has no clip list)", () => {
    expect(label("idle", ["models/hero.glb#Anim/Run"])).toBe("Replace Idler's default clip idle with Run");
    contribution().drop(scene, ["idle"], ["models/hero.glb#Anim/Run"]);
    expect(defaultClip("idle")).toBe("asset:models/hero.glb#Anim/Run");
  });

  it("refuses with a graph (adding a state is the graph editor's), saying why", () => {
    expect(label("graph", ["animation/run.anim.json"])).toMatch(/^Can't add run: it runs an animation graph/);
    contribution().drop(scene, ["graph"], ["animation/run.anim.json"]);
    expect(defaultClip("graph")).toBeUndefined();
    expect(status.value?.text).toMatch(/Can't add run to Graphed: it runs an animation graph, so the clip goes in as a state/);
  });

  it("refuses the clip the Animator already plays", () => {
    expect(label("idle", ["animation/idle.anim.json"])).toBe("Can't add idle: it already plays that clip on start");
    const steps = scene.stack.undoLabel;
    contribution().drop(scene, ["idle"], ["animation/idle.anim.json"]);
    expect(scene.stack.undoLabel).toBe(steps);
  });

  it("doesn't take other files, several clips, or a node without an Animator", () => {
    expect(label("empty", ["models/hero.glb"])).toBeNull();
    expect(label("empty", ["animation/run.anim.json", "animation/walk.anim.json"])).toBeNull();
    expect(label("plain", ["animation/run.anim.json"])).toBeNull();
    expect(label("empty", ["animation/run.anim.bin"])).toBe("Set run as Empty's default clip");
  });

  it("gives the Animator's Inspector card its drop zone", () => {
    expect(inspectorSectionsFor("engine.Animator", [["empty"]])).toHaveLength(1);
  });
});
