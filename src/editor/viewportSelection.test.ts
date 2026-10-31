import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../engine";
import { OrbitCamera } from "./OrbitCamera";
import { DEMO_SCENE, demoAssets, demoSettings, openSceneFile } from "./project";
import { openScene, sceneCamera, selection } from "./state";
import { chooseSelection, hitIds, installViewportSelection, isPlainClick } from "./viewportSelection";

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
