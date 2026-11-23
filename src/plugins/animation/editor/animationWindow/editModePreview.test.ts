// D135 (ADR 0026, 0373): the Animation window previews on the scene open in the editor, which is in edit mode, as the
// editor opens it (`openSceneFile`: `instantiateDocument` marks the scene node). In edit mode the scene's Animator does
// nothing by itself: its `defaultClip` (a walk with root motion, `rootMotion: "transform"`) doesn't play and the node
// stays put, frame after frame. The window's preview poses a light field and a skinned bone at the playhead; stopping
// puts the light back as the scene holds it and the skeleton back to rest (the renderer gets no pose: the bind pose).
// The scene document never changes. Play mode (a fresh Runtime World, ADR 0022) plays the same scene as before: the
// default clip plays and root motion moves the character. Binary fixtures are served from `file:` URLs, as the
// runtime tests serve them; the clip being edited is the project's `*.anim.json`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Input, Light } from "../../../../myco";
import { OrbitCamera } from "../../../../editor/OrbitCamera";
import { startPlay } from "../../../../editor/playMode";
import { editorSettings, useProjectAssets, type EditorProject } from "../../../../editor/projects";
import { editor } from "../../../../editor/sdk";
import { openSceneFile } from "../../../../editor/sceneTabs";
import { openScene, playState, sceneCamera, type OpenScene } from "../../../../editor/state";
import { closeTestProject, openTestProject } from "../../../../editor/testing";
import { useEditorPlugins } from "../../../testEditorPlugins";
import { skinningMatrices } from "../../runtime/skeletonInstances";
import { animationEditorPlugin } from "..";
import { animationSession as s } from "./animationSession";

useEditorPlugins([animationEditorPlugin]);

const fixtureUrl = (name: string) => new URL(`../../runtime/wasm/fixtures/${name}`, import.meta.url);
const SKEL = "anim/small.skel";
const WALK = "anim/walk.anim";
const POSE = "animation/pose.anim.json";
const frame = 1 / 60;

const SCENE = {
  format: "myco.scene@4",
  nodes: [
    {
      id: "hero",
      name: "Hero",
      components: [
        { type: "engine.Transform", data: {} },
        { type: "engine.Skeleton", data: { skeleton: `asset:${SKEL}` } },
        { type: "engine.Animator", data: { defaultClip: `asset:${WALK}`, rootMotion: "transform" } },
      ],
    },
    { id: "lamp", name: "Lamp", parent: "hero", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Light", data: { type: "point", intensity: 1 } }] },
  ],
};
/** The clip being edited: the lamp ramps 0 to 2, and bone1 turns 0.4 rad about +Y over its first half second. */
const POSE_CLIP = {
  format: "myco.anim-source@1",
  duration: 1,
  tracks: [
    { kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, 2]]] },
    { kind: "bone", target: { bone: "bone1" }, translation: [], scale: [], rotation: [[0, 0, 0, 0, 1], [0.5, 0, Math.sin(0.2), 0, Math.cos(0.2)], [1, 0, Math.sin(0.2), 0, Math.cos(0.2)]] },
  ],
};

let engine: Engine;
let project: EditorProject;
let scene: OpenScene;
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Frames of editor time, letting loads finish between them. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    engine.step(frame);
    await tick();
  }
}

beforeEach(async () => {
  Input.reset();
  playState.value = "edit";
  ({ project } = await openTestProject({ "scenes/main.scene.json": JSON.stringify(SCENE), [POSE]: JSON.stringify(POSE_CLIP) }));
  useProjectAssets(project);
  Assets.addSource(Assets.fromObject({ [SKEL]: fixtureUrl("small.skel").href, [WALK]: fixtureUrl("walk.anim").href }));
  engine = await Engine.create({ headless: true, kind: "editor", project: editorSettings(project) });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, "scenes/main.scene.json");
  scene = openScene.value!;
  s.open.value = true;
});

afterEach(() => {
  s.setPreview(false);
  s.chosen.value = new Map();
  s.open.value = false;
  editor.scene.selection.set([]);
  sceneCamera.value = null;
  engine.dispose();
  closeTestProject();
});

describe("previews on the scene being edited (D135)", () => {
  it("leaves an edit-mode Animator still; the preview poses a field and a bone, and stopping restores both", async () => {
    const hero = scene.sync.nodeFor(["hero"])!;
    const anim = hero.getComponent(Animator)!;
    const light = scene.sync.nodeFor(["lamp"])!.getComponent(Light)!;
    expect(engine.world.inEditMode(hero.entity)).toBe(true); // as the editor opens it
    const saved = JSON.stringify(scene.doc.toJSON());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Nothing moves by itself: no default clip, no root motion, no pose.
    await frames(30);
    expect(anim.state().name).toBe("");
    expect(hero.transform!.position.toArray()).toEqual([0, 0, 0]);
    expect(skinningMatrices(engine.world, hero)).toBeNull();
    expect(light.intensity).toBe(1);

    // The window's preview of the chosen clip, at 0.2 s (a frame of its 30 fps): the lamp at 0.4, bone1 turned 0.16 rad about +Y.
    s.chosen.value = new Map([["hero", POSE]]);
    editor.scene.selection.set(["lamp"]);
    expect(s.document.value?.path).toBe(POSE);
    s.setPreview(true);
    s.seek(0.2);
    s.show();
    await vi.waitFor(async () => {
      await frames(1);
      expect(light.intensity).toBeCloseTo(0.4, 4);
      const q = anim.bone("bone1").localRotation;
      expect(Math.abs(q.x) + Math.abs(q.z)).toBeLessThan(1e-4);
      expect(Math.abs(q.y * Math.sign(q.w) - Math.sin(0.08))).toBeLessThan(1e-3);
    });
    expect(skinningMatrices(engine.world, hero)).not.toBeNull();
    // Still nothing by itself while previewing: no time passes, no root motion.
    await frames(10);
    expect(light.intensity).toBeCloseTo(0.4, 4);
    expect(hero.transform!.position.toArray()).toEqual([0, 0, 0]);

    // Stop: the lamp as the scene holds it, the skeleton back to rest (no pose for the renderer), and it stays so.
    s.setPreview(false);
    expect(light.intensity).toBe(1);
    expect(skinningMatrices(engine.world, hero)).toBeNull();
    await frames(30);
    expect(light.intensity).toBe(1);
    expect(skinningMatrices(engine.world, hero)).toBeNull();
    expect(anim.state().name).toBe("");
    expect(hero.transform!.position.toArray()).toEqual([0, 0, 0]);
    expect(JSON.stringify(scene.doc.toJSON())).toBe(saved);
    warn.mockRestore();
  });

  it("plays the scene in play mode as before: the default clip plays and root motion moves the character", async () => {
    const editorHero = scene.sync.nodeFor(["hero"])!;
    const play = await startPlay({ editor: engine, scene, project });
    try {
      expect(play.engine.world.kind).toBe("runtime");
      const hero = play.engine.world.sceneNodes.flatMap((n) => n.children).find((n) => n.name === "Hero")!;
      const anim = hero.getComponent(Animator)!;
      await vi.waitFor(async () => {
        play.engine.step(frame);
        await tick();
        expect(anim.state().name).not.toBe("");
      });
      for (let i = 0; i < 10; i++) play.engine.step(frame);
      expect(hero.transform!.position.length).toBeGreaterThan(0.01);
      expect(skinningMatrices(play.engine.world, hero)).not.toBeNull();
    } finally {
      play.stop();
    }
    expect(editorHero.transform!.position.toArray()).toEqual([0, 0, 0]); // the edited scene didn't move
  });
});
