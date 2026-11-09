// Field targets (ADR 0158): the one interface Inspector field rows write through, with its document
// adapter (on the demo scene: `bg-a` and `bg-b` are instances of the background prefab at [0, 3, 0],
// bg-b overriding its position to [32, 3, 0]) and its live-World adapter.
import { beforeEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Input, PlainObject, Quaternion, behavior, field } from "../myco";
import { listComponents, type ComponentInfo } from "../engine/editor";
import { AddComponent, SetField, type NodePath } from "./document";
import { eulerAnglesOf } from "./fieldEdits";
import { documentFieldTarget, liveFieldTarget, type FieldTarget } from "./fieldTarget";
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

let engine: Engine;

beforeEach(async () => {
  Input.reset();
  engine = await Engine.create({ headless: true, kind: "editor", project: demoSettings(), assets: demoAssets() });
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

  it("makes a scrub drag one undo step, however many writes it makes", () => {
    const { stack, doc } = scene();
    const t = docTarget([["bird"]], TRANSFORM);
    const before = stack.allStates.length;
    const end = t.drag("Drag position");
    t.setAxis(fieldOf(t, "position"), 0, 1);
    t.setAxis(fieldOf(t, "position"), 0, 2);
    end();
    end(); // ending twice is harmless
    expect(stack.allStates).toHaveLength(before + 1);
    expect(stack.undoLabel).toBe("Drag position");
    expect(doc.fieldValue("bird", TRANSFORM, "position")).toEqual([2, 1, 0]);
  });

  it("sets an unset (Auto) vector explicitly", () => {
    scene().stack.execute(new SetField("bird-sprite", "engine.SpriteRenderer", "size", null));
    const t = docTarget([["bird-sprite"]], "engine.SpriteRenderer");
    const size = fieldOf(t, "size");
    expect(size.value).toBeNull();
    t.set(size, [1, 1]);
    expect(scene().doc.fieldValue("bird-sprite", "engine.SpriteRenderer", "size")).toEqual([1, 1]);
  });

  it("offers the document's nodes by id, and writes a picked one as a reference", () => {
    scene().stack.execute(new AddComponent("bird", { type: "test.fieldTarget.Probe" }));
    const t = docTarget([["bird"]], "test.fieldTarget.Probe");
    expect(t.nodes.choices().map((c) => c.key)).toContain("score");
    t.set(fieldOf(t, "target"), "score");
    expect(scene().doc.fieldValue("bird", "test.fieldTarget.Probe", "target")).toEqual({ $node: "score" });
    const after = docTarget([["bird"]], "test.fieldTarget.Probe");
    expect(after.nodes.keyOf(fieldOf(after, "target").value)).toBe("score");
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

  it("writes a rotation's Euler degrees axis by axis, keeping the others, with no document involved", () => {
    const before = scene().stack.allStates.length;
    expect(live().setAxis(fieldOf(live(), "facing"), 2, 30)).toBeNull();
    expect(eulerAnglesOf(probe().facing)).toEqual([0, 0, 30]);
    live().setAxis(fieldOf(live(), "facing"), 0, 10);
    expect(eulerAnglesOf(probe().facing)).toEqual([10, 0, 30]);
    expect(probe().facing).toBeInstanceOf(Quaternion);
    expect(edits).toBe(2);
    expect(scene().stack.allStates).toHaveLength(before);
  });

  it("writes choices, numbers, objects and the Transform", () => {
    live().set(fieldOf(live(), "pace"), "fast");
    expect(probe().pace).toBe("fast");
    live().set(fieldOf(live(), "speed"), 4);
    expect(probe().speed).toBe(4);
    live().set(fieldOf(live(), "tuning"), { gain: 2, label: "b" });
    expect(probe().tuning).toEqual({ gain: 2, label: "b" });
    live(TRANSFORM).setAxis(fieldOf(live(TRANSFORM), "position"), 1, 5);
    expect(node.transform!.position.toArray()).toEqual([0, 5, 0]);
    expect(live().state(fieldOf(live(), "pace"))).toEqual({ values: ["fast"], mixed: false, overridden: false });
  });

  it("offers the World's nodes by entity for references and list items, and refuses others", () => {
    const keys = live().nodes.choices().map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining([String(node.entity), String(other.entity)]));
    expect(live().set(fieldOf(live(), "target"), String(other.entity))).toBeNull();
    expect(probe().target).toBe(other);
    expect(live().nodes.keyOf(probe().target)).toBe(String(other.entity));
    live().set(fieldOf(live(), "stops"), [String(other.entity), null, node]);
    expect(probe().stops).toEqual([other, null, node]);
    expect(live().set(fieldOf(live(), "target"), "999999")).toMatch(/isn't in World/);
    expect(probe().target).toBe(other);
    live().set(fieldOf(live(), "target"), null);
    expect(probe().target).toBeNull();
  });

  it("says why when the node is gone", () => {
    const t = live();
    GameObject.destroy(node);
    game.world._flushDestroyed();
    expect(t.set(fieldOf(t, "speed"), 2)).toBe("the node has been destroyed");
  });
});
