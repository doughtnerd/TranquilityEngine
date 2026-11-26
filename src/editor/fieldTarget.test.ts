// Field targets (ADR 0243): the one interface Inspector field rows write through, with its document
// adapter (on the demo scene: `bg-a` and `bg-b` are instances of the background prefab at [0, 3, 0],
// bg-b overriding its position to [32, 3, 0]) and its live-World adapter.
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Input, PlainObject, Quaternion, behavior, field } from "../myco";
import { listComponents, type ComponentInfo } from "../engine/editor";
import { AddComponent, SetField, type NodePath } from "./document";
import { rotationCodec } from "./fields/rotationCodec";
import { documentFieldTarget, liveFieldTarget, type FieldTarget } from "./fieldTarget";
import { deleteLive } from "./liveEdits";
import { OrbitCamera } from "./OrbitCamera";
import { openSceneFile } from "./project";
import { openScene, sceneCamera } from "./state";
import { DEMO_SCENE, demoAssets, demoSettings } from "./testing";

@behavior("test.fieldTarget.Probe")
class Probe extends GameBehavior {
  @field(Number) speed = 1;
  @field(Quaternion) facing = new Quaternion();
  @field(String, { choices: ["slow", "fast"] }) pace = "slow";
  @field(GameObject) target: GameObject | null = null;
  @field([GameObject]) stops: (GameObject | null)[] = [];
  @field(PlainObject) tuning: Record<string, unknown> = { gain: 1, label: "a" };
}

beforeEach(async () => {
  Input.reset();
  const engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
  sceneCamera.value = OrbitCamera.create(GameObject.create("SceneCamera", { parent: engine.world.root }));
  openSceneFile(engine, DEMO_SCENE);
});

const scene = () => openScene.value!;
const infoOf = (node: GameObject, type: string): ComponentInfo => listComponents(node).find((c) => c.type === type)!;
const fieldOf = (target: FieldTarget, name: string) => target.info.fields.find((f) => f.name === name)!;
/** A document target for component `type` on the nodes at `paths`, read afresh (edits rebuild instances). */
const docTarget = (paths: NodePath[], type: string) => documentFieldTarget(scene(), paths, paths.map((p) => infoOf(scene().sync.nodeFor(p)!, type)));
const TRANSFORM = "engine.Transform";
const instances: NodePath[] = [["bg-a"], ["bg-b"]];
const positionOverride = (id: string) => scene().doc.overrides(id).find((o) => o.component === TRANSFORM && o.field === "position")?.value;
/** A rotation as Euler radians (ZXY, ADR 0164), rounded for comparison. */
const radians = (q: Quaternion) => rotationCodec("radians").read(q).map((r) => Math.round(r * 1e4) / 1e4);

describe("the document adapter", () => {
  it("reports mixed values and overrides, and commits one axis on every node as one undo step", () => {
    const t = docTarget(instances, TRANSFORM);
    const position = fieldOf(t, "position");
    expect(t.state(position)).toMatchObject({ mixed: true, overridden: true });
    expect(t.setAxis(position, 1, 7)).toBeNull();
    expect(positionOverride("bg-a")).toEqual([0, 7, 0]);
    expect(positionOverride("bg-b")).toEqual([32, 7, 0]);
    expect(scene().stack.undoLabel).toBe("Set position on 2 nodes");
    expect(docTarget(instances, TRANSFORM).state(position).mixed).toBe(true); // x still differs
    docTarget(instances, TRANSFORM).revert(position);
    expect(positionOverride("bg-a")).toBeUndefined();
    expect(positionOverride("bg-b")).toBeUndefined();
    expect(docTarget(instances, TRANSFORM).state(position)).toMatchObject({ mixed: false, overridden: false });
  });

  it("makes a scrub drag one undo step, however many writes it makes; cancelling puts the value back", () => {
    const { stack, doc } = scene();
    const t = docTarget([["bird"]], TRANSFORM);
    const position = fieldOf(t, "position");
    const before = stack.allStates.length;
    const drag = t.drag(position, "Drag position");
    t.setAxis(position, 0, 1);
    t.setAxis(position, 0, 2);
    drag.end();
    drag.end(); // ending twice is harmless
    expect(drag.open).toBe(false);
    expect(stack.allStates).toHaveLength(before + 1);
    expect(stack.undoLabel).toBe("Drag position");
    expect(doc.fieldValue("bird", TRANSFORM, "position")).toEqual([2, 1, 0]);

    const cancelled = docTarget([["bird"]], TRANSFORM).drag(position, "Drag position");
    docTarget([["bird"]], TRANSFORM).setAxis(position, 0, 9);
    cancelled.cancel();
    expect(doc.fieldValue("bird", TRANSFORM, "position")).toEqual([2, 1, 0]);
    expect(stack.allStates).toHaveLength(before + 1);
  });

  it("sets an unset (Auto) vector explicitly", () => {
    scene().stack.execute(new SetField("bird-sprite", "engine.SpriteRenderer", "size", null));
    const t = docTarget([["bird-sprite"]], "engine.SpriteRenderer");
    const size = fieldOf(t, "size");
    expect(size.value).toBeNull();
    t.set(size, [1, 1]);
    expect(scene().doc.fieldValue("bird-sprite", "engine.SpriteRenderer", "size")).toEqual([1, 1]);
  });

  it("sets each node's own rotation, as a rotation field's axis edit does", () => {
    const t = docTarget(instances, TRANSFORM);
    const rotation = fieldOf(t, "rotation");
    const turned = rotationCodec("radians").write([0, 0, 0.5], new Quaternion());
    expect(t.setEach(rotation, [turned, new Quaternion()])).toBeNull();
    const after = docTarget(instances, TRANSFORM).state(rotation);
    expect(after.mixed).toBe(true);
    expect(radians(after.values[0] as Quaternion)).toEqual([0, 0, 0.5]);
  });

  it("offers the document's nodes by id, and writes a picked one as a reference", () => {
    scene().stack.execute(new AddComponent("bird", { type: "test.fieldTarget.Probe" }));
    const t = docTarget([["bird"]], "test.fieldTarget.Probe");
    expect(t.nodes.choices().map((c) => c.key)).toContain("hud");
    t.set(fieldOf(t, "target"), "hud");
    expect(scene().doc.fieldValue("bird", "test.fieldTarget.Probe", "target")).toEqual({ $node: "hud" });
    const after = docTarget([["bird"]], "test.fieldTarget.Probe");
    expect(after.nodes.keyOf(fieldOf(after, "target").value)).toBe("hud");
  });
});

describe("the live adapter", () => {
  let game: Engine;
  let node: GameObject;
  let other: GameObject;
  let edits: number;
  const probe = () => node.getBehavior(Probe)!;
  const live = (type = "test.fieldTarget.Probe") => liveFieldTarget(node, infoOf(node, type), () => edits++);

  beforeEach(async () => {
    game = await Engine.create({ headless: true });
    node = GameObject.create("Probe", { parent: game.world.root });
    other = GameObject.create("Other", { parent: game.world.root });
    node.addBehavior(Probe);
    edits = 0;
  });

  it("writes a rotation axis by axis as its view shows it, keeping the others, with no document involved", () => {
    const before = scene().stack.allStates.length;
    expect(live().setAxis(fieldOf(live(), "facing"), 2, 0.5)).toBeNull();
    expect(radians(probe().facing)).toEqual([0, 0, 0.5]);
    live().setAxis(fieldOf(live(), "facing"), 0, 0.25);
    expect(radians(probe().facing)).toEqual([0.25, 0, 0.5]);
    expect(probe().facing).toBeInstanceOf(Quaternion);
    expect(edits).toBe(2);
    expect(scene().stack.allStates).toHaveLength(before);
  });

  it("writes choices, numbers, objects, a rotation field's commit and the Transform", () => {
    live().set(fieldOf(live(), "pace"), "fast");
    expect(probe().pace).toBe("fast");
    live().set(fieldOf(live(), "speed"), 4);
    expect(probe().speed).toBe(4);
    live().set(fieldOf(live(), "tuning"), { gain: 2, label: "b" });
    expect(probe().tuning).toEqual({ gain: 2, label: "b" });
    live().setEach(fieldOf(live(), "facing"), [rotationCodec("radians").write([0, 1, 0], new Quaternion())]);
    expect(radians(probe().facing)).toEqual([0, 1, 0]);
    live(TRANSFORM).setAxis(fieldOf(live(TRANSFORM), "position"), 1, 5);
    expect(node.transform!.position.toArray()).toEqual([0, 5, 0]);
    expect(live().state(fieldOf(live(), "pace"))).toEqual({ values: ["fast"], mixed: false, overridden: false });
  });

  it("cancelling a scrub drag writes the value it started from", () => {
    const t = live();
    const drag = t.drag(fieldOf(t, "speed"), "Drag speed");
    live().set(fieldOf(live(), "speed"), 3);
    live().set(fieldOf(live(), "speed"), 5);
    drag.cancel();
    expect(probe().speed).toBe(1);
    expect(drag.open).toBe(false);
  });

  it("offers the World's nodes by entity for references and list items, and refuses others", () => {
    const choices = live().nodes.choices();
    const otherKey = choices.find((c) => c.label === "Other")!.key;
    expect(choices.map((c) => c.key)).toEqual(expect.arrayContaining([live().nodes.keyOf(node), otherKey]));
    expect(live().set(fieldOf(live(), "target"), otherKey)).toBeNull();
    expect(probe().target).toBe(other);
    expect(live().nodes.keyOf(probe().target)).toBe(otherKey);
    live().set(fieldOf(live(), "stops"), [otherKey, null, node]);
    expect(probe().stops).toEqual([other, null, node]);
    expect(live().set(fieldOf(live(), "target"), "999999")).toMatch(/isn't in World/);
    expect(probe().target).toBe(other);
    live().set(fieldOf(live(), "target"), null);
    expect(probe().target).toBeNull();
  });

  it("says why when the node is gone", () => {
    const t = live();
    expect(deleteLive(node)).toBeNull(); // the live Hierarchy's Delete, as a user would
    expect(t.set(fieldOf(t, "speed"), 2)).toBe("the node has been destroyed");
  });
});
