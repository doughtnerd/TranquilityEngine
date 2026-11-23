// T50 (ADR 0373): the Animation window's session in a headless editor with a project and an open scene, through the
// editor SDK as the Inspector and gizmos use it. Selecting a node under an Animator binds the window to the Animator's
// default clip; with record mode on, field writes to animatable fields key the clip at the playhead instead of changing
// the scene, a drag's writes (one undo step of the scene) become one undo step on the clip, a cancelled drag records
// nothing, and with record mode off writes reach the scene as usual.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../../../../myco";
import type { AnimSource } from "../../../../engine/animation/animSource";
import { OrbitCamera } from "../../../../editor/OrbitCamera";
import { editorSettings, useProjectAssets } from "../../../../editor/projects";
import { editor } from "../../../../editor/sdk";
import { openSceneFile } from "../../../../editor/sceneTabs";
import { openScene, playState, sceneCamera, type OpenScene } from "../../../../editor/state";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { animationEditorPlugin } from "..";
import { animationSession as s } from "./animationSession";

useEditorPlugins([animationEditorPlugin]);

const CLIP = "animation/run.anim.json";
const SCENE = {
  format: "myco.scene@4",
  nodes: [
    { id: "hero", name: "Hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Animator", data: { defaultClip: `asset:${CLIP}` } }] },
    { id: "lamp", name: "Lamp", parent: "hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "point", intensity: 1 } }] },
    { id: "loose", name: "Loose", components: [{ type: "engine.Transform", data: {} }] },
  ],
};

let engine: Engine;
let scene: OpenScene;
const lamp = (type = "engine.Transform") => ({ scene, path: ["lamp"], type });
const clip = (): AnimSource => s.document.peek()!.value.peek();

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  const { project } = await openTestProject({ "scenes/main.scene.json": JSON.stringify(SCENE), [CLIP]: JSON.stringify({ format: "myco.anim-source@1", duration: 1 }) });
  useProjectAssets(project);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  scene = openScene.value!;
  s.open.value = true;
});

afterEach(() => {
  s.setPreview(false);
  s.open.value = false;
  editor.scene.selection.set([]);
  sceneCamera.value = null;
  engine.dispose();
  closeTestProject();
});

describe("the Animation window's session (ADR 0373)", () => {
  it("binds to the Animator above the selected node and its default clip; a node outside any Animator binds nothing", () => {
    editor.scene.selection.set(["lamp"]);
    const t = s.target.value;
    expect(t.kind).toBe("animator");
    expect(t.kind === "animator" && t.path).toEqual(["hero"]);
    expect(s.clipFile.value).toBe(CLIP);
    expect(s.document.value?.path).toBe(CLIP);
    editor.scene.selection.set(["loose"]);
    expect(s.target.value.kind).toBe("none");
  });

  it("records a drag on an animatable field as one key and one undo step on the clip, leaving the scene alone", () => {
    editor.scene.selection.set(["lamp"]);
    s.setRecording(true);
    s.seek(0.5);
    const before = scene.doc.fieldValue("lamp", "engine.Transform", "position");
    const drag = editor.scene.beginFieldDrag(lamp(), "Move Lamp")!;
    expect(editor.scene.writeField(lamp(), "position", [1, 0, 0])).toBeNull();
    expect(editor.scene.writeField(lamp(), "position", [2, 0, 0])).toBeNull();
    expect(clip().tracks).toEqual([]); // nothing until the drag ends
    drag.end();
    expect(clip().tracks).toEqual([{ kind: "vec3", target: { nodePath: "Lamp", component: "engine.Transform", field: "position" }, name: "", curves: [[[0.5, 2]], [[0.5, 0]], [[0.5, 0]]] }]);
    expect(s.document.peek()!.undoLabel.value).toBe("Record position");
    expect(scene.doc.fieldValue("lamp", "engine.Transform", "position")).toEqual(before);
    // The viewport followed the drag: the live node shows the recorded value.
    expect(scene.sync.nodeFor(["lamp"])!.transform!.position.toArray()).toEqual([2, 0, 0]);
    s.document.peek()!.undo();
    expect(clip().tracks).toEqual([]);
  });

  it("records a single Inspector write at once, and a cancelled drag records nothing", () => {
    editor.scene.selection.set(["lamp"]);
    s.setRecording(true);
    s.seek(0.2);
    expect(editor.scene.writeField(lamp("engine.Light"), "intensity", 3)).toBeNull();
    expect(clip().tracks).toEqual([{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0.2, 3]]] }]);
    expect(scene.doc.fieldValue("lamp", "engine.Light", "intensity")).toBe(1);
    const drag = editor.scene.beginFieldDrag(lamp(), "Move Lamp")!;
    editor.scene.writeField(lamp(), "position", [5, 0, 0]);
    drag.cancel();
    expect(clip().tracks).toHaveLength(1);
    expect(scene.sync.nodeFor(["lamp"])!.transform!.position.toArray()).toEqual([0, 0, 0]);
  });

  it("leaves writes to the scene when record mode is off, and fields no track drives even when it is on", () => {
    editor.scene.selection.set(["lamp"]);
    expect(editor.scene.writeField(lamp("engine.Light"), "intensity", 4)).toBeNull();
    expect(scene.doc.fieldValue("lamp", "engine.Light", "intensity")).toBe(4);
    s.setRecording(true);
    expect(editor.scene.writeField(lamp("engine.Light"), "range", 4)).toBeNull(); // a number: animatable, so keyed
    expect(clip().tracks).toHaveLength(1);
    expect(editor.scene.writeField({ scene, path: ["loose"], type: "engine.Transform" }, "position", [1, 1, 1])).toBeNull(); // not under the Animator
    expect(scene.doc.fieldValue("loose", "engine.Transform", "position")).toEqual([1, 1, 1]);
  });
});
