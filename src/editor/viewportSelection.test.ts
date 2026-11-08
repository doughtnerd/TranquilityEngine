import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { openScene, sceneCamera, selectedKeys, selection } from "./state";
import { chooseSelection, hitIds, installViewportSelection, isPlainClick } from "./viewportSelection";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";
import { FakeRenderSurface } from "../engine/render/fakeViewport";
import { installGizmo } from "./gizmo";

describe("click versus drag", () => {
  it("counts a left press and release with little movement as a click", () => {
    expect(isPlainClick({ x: 10, y: 10, button: 0 }, { x: 12, y: 11, button: 0 })).toBe(true);
  });

  it("rejects drags, Alt + left (camera orbit) and other buttons", () => {
    expect(isPlainClick({ x: 10, y: 10, button: 0 }, { x: 20, y: 10, button: 0 })).toBe(false);
    expect(isPlainClick({ x: 10, y: 10, button: 0, alt: true }, { x: 10, y: 10, button: 0 })).toBe(false);
    expect(isPlainClick({ x: 10, y: 10, button: 2 }, { x: 10, y: 10, button: 2 })).toBe(false);
  });
});

describe("choosing what a click selects", () => {
  it("clears on empty space and takes the topmost hit", () => {
    expect(chooseSelection([], "bird", false)).toBeNull();
    expect(chooseSelection(["bird-sprite", "bg-a"], null, false)).toBe("bird-sprite");
    expect(chooseSelection(["bird-sprite", "bg-a"], "bg-a", false)).toBe("bird-sprite"); // a new spot starts from the top
  });

  it("cycles through overlapping hits when clicking the same spot", () => {
    const hits = ["bird-sprite", "bg-a", "ground-a"];
    expect(chooseSelection(hits, "bird-sprite", true)).toBe("bg-a");
    expect(chooseSelection(hits, "bg-a", true)).toBe("ground-a");
    expect(chooseSelection(hits, "ground-a", true)).toBe("bird-sprite");
    expect(chooseSelection(hits, "camera", true)).toBe("bird-sprite"); // selection not under the pointer
  });
});

describe("with the demo scene open", () => {
  let engine: Engine;
  let orbit: OrbitCamera;
  let uninstall: () => void;

  beforeEach(async () => {
    Input.reset();
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    orbit = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    sceneCamera.value = orbit;
    openSceneFile(engine, DEMO_SCENE);
    uninstall = installViewportSelection(engine, orbit);
  });

  afterEach(() => uninstall());

  it("maps picked nodes to document ids, dropping duplicates and nodes outside the document", () => {
    const sync = openScene.value!.sync;
    const birdSprite = sync.nodeFor("bird-sprite")!;
    const bgTile = sync.nodeFor("bg-a")!; // the background prefab's root sprite: selects the instance
    const ids = hitIds([birdSprite, bgTile, birdSprite, engine.world.root, orbit.gameObject], (n) => sync.nodeIdOf(n));
    expect(ids).toEqual(["bird-sprite", "bg-a"]);
  });

  it("F and Focus frame the selected node, or the origin with nothing selected", () => {
    selection.value = "bird";
    orbit.focus();
    expect(orbit.focusPoint.toArray()).toEqual([-4, 1, 0]);

    orbit.focus([5, 5, 0]);
    Input.simulate("down", "f");
    engine.step(1 / 60);
    expect(orbit.focusPoint.toArray()).toEqual([-4, 1, 0]);

    selection.value = null;
    orbit.focus();
    expect(orbit.focusPoint.toArray()).toEqual([0, 0, 0]);
  });
});

/** A pointer event at a canvas point (the fake surface's canvas sits at the page origin). */
function pointer(type: string, x: number, y: number, init: { button?: number; shiftKey?: boolean } = {}): Event {
  return Object.assign(new Event(type), { clientX: x, clientY: y, button: init.button ?? 0, pointerId: 1, altKey: false, shiftKey: init.shiftKey ?? false, ctrlKey: false, metaKey: false });
}

describe("clicking in the viewport, over a fake viewport (ADR 0128)", () => {
  let engine: Engine;
  let surface: FakeRenderSurface;
  let uninstall: () => void;
  const click = (x: number, y: number, init?: { shiftKey?: boolean }) => {
    surface.canvas.dispatchEvent(pointer("pointerdown", x, y, init));
    surface.canvas.dispatchEvent(pointer("pointerup", x, y, init));
  };

  beforeEach(async () => {
    Input.reset();
    engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
    surface = new FakeRenderSurface();
    engine.world.render = surface;
    const orbit = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
    sceneCamera.value = orbit;
    openSceneFile(engine, DEMO_SCENE);
    uninstall = installViewportSelection(engine, orbit);
    selection.value = null;
  });

  afterEach(() => {
    uninstall();
    engine.world.render = null;
  });

  it("selects the topmost node the viewport picks, outlines it, and clears on empty space", () => {
    const sync = openScene.value!.sync;
    const bird = sync.nodeFor("bird-sprite")!, ground = sync.nodeFor("ground-a")!;
    surface.adapter.rects.set(ground, { left: 0, top: 400, right: 800, bottom: 600 });
    surface.adapter.rects.set(bird, { left: 380, top: 380, right: 420, bottom: 420 });
    click(400, 410);
    expect(selection.value).toBe("bird-sprite");
    expect(surface.adapter.selection).toEqual([bird]);
    click(100, 500);
    expect(selection.value).toBe("ground-a");
    click(100, 100);
    expect(selection.value).toBeNull();
    expect(surface.adapter.selection).toEqual([]);
  });

  it("cycles through overlapping hits when the same spot is clicked again, and Shift adds", () => {
    const sync = openScene.value!.sync;
    surface.adapter.rects.set(sync.nodeFor("ground-a")!, { left: 0, top: 0, right: 800, bottom: 600 });
    surface.adapter.rects.set(sync.nodeFor("bird-sprite")!, { left: 0, top: 0, right: 800, bottom: 600 });
    click(400, 300);
    expect(selection.value).toBe("bird-sprite");
    click(400, 300);
    expect(selection.value).toBe("ground-a");
    surface.adapter.rects.delete(sync.nodeFor("ground-a")!);
    surface.adapter.rects.set(sync.nodeFor("bg-a")!, { left: 0, top: 0, right: 10, bottom: 10 });
    click(5, 5, { shiftKey: true });
    expect(selectedKeys.value.length).toBe(2);
  });

  it("puts the gizmo on the selection, and a press on the gizmo never changes the selection", () => {
    const stopGizmo = installGizmo(engine);
    const sync = openScene.value!.sync;
    const bird = sync.nodeFor("bird-sprite")!;
    surface.adapter.rects.set(bird, { left: 0, top: 0, right: 800, bottom: 600 });
    click(400, 300);
    expect(surface.adapter.gizmo?.nodes).toEqual([bird]);
    surface.adapter.gizmoRect = { left: 390, top: 290, right: 410, bottom: 310 };
    surface.adapter.rects.clear();
    click(400, 300); // on the gizmo: kept, though nothing is under it
    expect(selection.value).toBe("bird-sprite");
    click(100, 100);
    expect(selection.value).toBeNull();
    expect(surface.adapter.gizmo).toBeNull();
    stopGizmo();
  });
});

