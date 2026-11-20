// The component field write (ADR 0257): what the Inspector, plugin sections and gizmos share. On the demo scene,
// `bird` is a plain node and `bg-a` / `bg-b` are instances of the background prefab at [0, 3, 0] (bg-b overriding its
// position to [32, 3, 0]).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameObject, Input } from "../myco";
import { beginFieldDrag, storedFieldValue, writeComponentField } from "./componentField";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { openScene, playState, sceneCamera, status } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

const TRANSFORM = "engine.Transform";
let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, DEMO_SCENE);
  status.value = null;
});

afterEach(() => {
  playState.value = "edit";
});

const scene = () => openScene.value!;
const at = (path: string[]) => ({ scene: scene(), path, type: TRANSFORM });

describe("in a scene document", () => {
  it("writes a plain node's field as an undo step, and an instance's as an override", () => {
    expect(writeComponentField(at(["bird"]), "position", [1, 2, 0])).toBeNull();
    expect(scene().doc.fieldValue("bird", TRANSFORM, "position")).toEqual([1, 2, 0]);
    expect(scene().stack.undoLabel).toBe("Set position");

    expect(writeComponentField(at(["bg-a"]), "position", [5, 3, 0])).toBeNull();
    expect(scene().doc.node("bg-a").components).toBeUndefined();
    expect(storedFieldValue(at(["bg-a"]), "position")).toEqual([5, 3, 0]);
    expect(scene().doc.overrides("bg-a").some((o) => o.component === TRANSFORM && o.field === "position")).toBe(true);
    scene().stack.undo();
    expect(storedFieldValue(at(["bg-a"]), "position")).toBeUndefined();
  });

  it("skips a value already stored, so nothing is recorded", () => {
    writeComponentField(at(["bird"]), "position", [1, 2, 0]);
    const states = scene().stack.allStates.length;
    expect(writeComponentField(at(["bird"]), "position", [1, 2, 0])).toBeNull();
    expect(scene().stack.allStates).toHaveLength(states);
  });

  it("makes a drag one undo step, however many writes; cancelling puts the values back", () => {
    const { stack, doc } = scene();
    const before = stack.allStates.length;
    const drag = beginFieldDrag(at(["bird"]), "Drag position")!;
    for (const x of [1, 2, 3]) writeComponentField(at(["bird"]), "position", [x, 0, 0]);
    drag.end();
    expect(stack.allStates).toHaveLength(before + 1);
    expect(stack.undoLabel).toBe("Drag position");
    expect(doc.fieldValue("bird", TRANSFORM, "position")).toEqual([3, 0, 0]);

    const cancelled = beginFieldDrag(at(["bird"]), "Drag position")!;
    writeComponentField(at(["bird"]), "position", [9, 0, 0]);
    cancelled.cancel();
    expect(doc.fieldValue("bird", TRANSFORM, "position")).toEqual([3, 0, 0]);
    expect(stack.allStates).toHaveLength(before + 1);
  });

  it("refuses while playing, with the edit gate's one wording, and opens no drag", () => {
    const value = scene().doc.fieldValue("bird", TRANSFORM, "position");
    playState.value = "playing";
    expect(writeComponentField(at(["bird"]), "position", [7, 7, 7])).toBe("stop playing to edit the scene");
    expect(status.value?.text).toBe("Stop playing to edit the scene.");
    expect(scene().doc.fieldValue("bird", TRANSFORM, "position")).toEqual(value);
    expect(beginFieldDrag(at(["bird"]), "Drag position")).toBeNull();
  });

  it("says why when the node is gone", () => {
    expect(writeComponentField(at(["nobody"]), "position", [0, 0, 0])).toBe("the node isn't in the scene any more");
    expect(writeComponentField(at(["bg-a", "nobody"]), "position", [0, 0, 0])).toBe("the node isn't in its prefab instance any more");
  });
});

describe("on a live node", () => {
  it("writes the running World only, during play, and a cancelled drag writes the start back", () => {
    const live = GameObject.create("Live", { parent: engine.world.root });
    playState.value = "playing"; // live writes aren't the document's: the gate doesn't apply
    const place = { node: live, type: TRANSFORM };
    const drag = beginFieldDrag(place, "Drag position", ["position"])!;
    expect(writeComponentField(place, "position", [4, 5, 6])).toBeNull();
    expect(live.transform!.position.toArray()).toEqual([4, 5, 6]);
    expect(storedFieldValue(place, "position")).toEqual([4, 5, 6]);
    drag.cancel();
    expect(live.transform!.position.toArray()).toEqual([0, 0, 0]);
    expect(writeComponentField({ node: live, type: "engine.Nothing" }, "x", 1)).toBe("Nothing has no field x");
    GameObject.destroy(live);
  });
});
