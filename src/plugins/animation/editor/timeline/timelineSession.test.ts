// T53 (ADR 0373): the Timeline window's session in a headless editor with a project and an open scene, through the editor
// SDK as the panels use it. Selecting a node under a TimelineDirector binds the window to the director's timeline; edits
// are one undo step on the timeline's document, a refused edit changes nothing, nested timelines open and the breadcrumb
// leads back, and the preview plays the edited timeline on the director in the Editor World and puts the scene back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine, GameObject, Input, Light } from "../../../../myco";
import { OrbitCamera } from "../../../../editor/OrbitCamera";
import { editorSettings, useProjectAssets } from "../../../../editor/projects";
import { editor, mapEdit } from "../../../../editor/sdk";
import { openSceneFile } from "../../../../editor/sceneTabs";
import { openScene, playState, sceneCamera, type OpenScene } from "../../../../editor/state";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { animationEditorPlugin } from "..";
import { addItem, splitItem } from "./timelineEditLogic";
import { timelineSession as s } from "./timelineSession";

useEditorPlugins([animationEditorPlugin]);

const FILE = "animation/intro.timeline.json";
const INNER = "animation/inner.timeline.json";
const SCENE = {
  format: "myco.scene@4",
  nodes: [
    { id: "dir", name: "Dir", components: [{ type: "engine.Transform", data: {} }, { type: "engine.TimelineDirector", data: { timeline: `asset:${FILE}`, playOnStart: false } }] },
    { id: "lamp", name: "Lamp", parent: "dir", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "point", intensity: 1 } }] },
    { id: "loose", name: "Loose", components: [{ type: "engine.Transform", data: {} }] },
  ],
};
const lampRamp = (to: number) => ({ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, curves: [[[0, 0], [1, to]]] });
const intro = { format: "myco.timeline@1", duration: 4, tracks: [lampRamp(2), { kind: "subclip", keys: [{ time: 1, end: 3, clip: `asset:${INNER}` }, { time: 3, end: 4, clip: "asset:animation/wave.anim.json" }] }] };

let engine: Engine;
let scene: OpenScene;
const timeline = () => s.document.peek()!.value.peek();

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  const { project } = await openTestProject({
    "scenes/main.scene.json": JSON.stringify(SCENE),
    [FILE]: JSON.stringify(intro),
    [INNER]: JSON.stringify({ format: "myco.timeline@1", duration: 2, tracks: [] }),
    "animation/wave.anim.json": JSON.stringify({ format: "myco.anim-source@1", duration: 1 }),
  });
  useProjectAssets(project);
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  scene = openScene.value!;
  s.open.value = true;
});

afterEach(() => {
  s.setPreview(false);
  s.goTo([]);
  s.open.value = false;
  editor.scene.selection.set([]);
  sceneCamera.value = null;
  engine.dispose();
  closeTestProject();
});

describe("the Timeline window's session (ADR 0373)", () => {
  it("binds to the director above the selected node and its timeline; a node outside any director binds nothing", () => {
    editor.scene.selection.set(["lamp"]);
    const t = s.target.value;
    expect(t.kind === "director" && t.path).toEqual(["dir"]);
    expect(s.file.value).toBe(FILE);
    expect(s.document.value?.path).toBe(FILE);
    editor.scene.selection.set(["loose"]);
    expect(s.target.value.kind).toBe("none");
    expect(s.document.value).toBeNull();
  });

  it("applies an edit as one undo step on the document, and a refused edit changes nothing", () => {
    editor.scene.selection.set(["lamp"]);
    const doc = s.document.peek()!;
    expect(s.apply(mapEdit(addItem(timeline(), 1, 0, { kind: "subclip", clip: "animation/wave.anim.json" }), (r) => r.timeline), "Add clip")).toBe(true);
    expect(timeline().tracks[1]).toMatchObject({ keys: [{ time: 0 }, { time: 1 }, { time: 3 }] });
    expect(doc.undoLabel.value).toBe("Add clip");
    doc.undo();
    expect(timeline().tracks[1]).toMatchObject({ keys: [{ time: 1 }, { time: 3 }] });
    const before = timeline();
    expect(s.apply(mapEdit(splitItem(before, "1#0", 1), (r) => r.timeline), "Split clip")).toBe(false);
    expect(timeline()).toBe(before);
  });

  it("opens a nested timeline, leads back through the breadcrumb, and refuses clips and itself", () => {
    editor.scene.selection.set(["dir"]);
    expect(s.crumbs.value.map((c) => c.label)).toEqual(["intro"]);
    expect(s.openInner(`asset:${INNER}`)).toBe(true);
    expect(s.file.value).toBe(INNER);
    expect(s.crumbs.value.map((c) => c.label)).toEqual(["intro", "inner"]);
    expect(s.openInner(FILE)).toBe(false); // itself, above
    expect(s.openInner("asset:animation/wave.anim.json")).toBe(false); // a clip
    expect(s.file.value).toBe(INNER);
    s.goTo(s.crumbs.value[0]!.stack);
    expect(s.file.value).toBe(FILE);
    expect(s.crumbs.value).toHaveLength(1);
  });

  it("previews the edited timeline on the director, and puts the director and the scene back when it stops", async () => {
    editor.scene.selection.set(["lamp"]);
    const t = s.target.value;
    if (t.kind !== "director") throw new Error("not bound");
    const lamp = scene.sync.nodeFor(["lamp"])!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    s.setPreview(true);
    s.seek(0.5);
    const light = lamp.getComponent(Light)!;
    await vi.waitFor(() => {
      engine.step(0);
      expect(light.intensity).toBeCloseTo(1, 4); // the ramp 0 to 2 at 0.5 s
    });
    expect(t.director.timeline).toContain(".animation-preview/");
    s.setPreview(false);
    expect(t.director.timeline.replace(/^asset:/, "")).toBe(FILE);
    expect(t.director.playOnStart).toBe(false);
    expect(light.intensity).toBe(1); // the scene's own value is back
    warn.mockRestore();
  });
});
