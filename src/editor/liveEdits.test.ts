// Structural edits to a live World (ADR 0124): nodes created, renamed, deleted and reparented;
// components added and removed; node references set, all through the public API, applied at once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine, GameBehavior, GameObject, Input, behavior, defineComponent, f32, field } from "../engine";
import type { World } from "../engine/core/World";
import { engineWorld, instantiateDocument, listComponents, listNodes } from "../engine/editor";
import { addLiveComponent, createLiveNode, createLiveSibling, deleteLive, liveNodeChoices, moveLive, removeLiveComponent, renameLive, setLiveNodeRef, topLevelOf, whyNotDeleteLive, whyNotMoveLive, whyNotRemoveLive } from "./liveEdits";

const log: string[] = [];

@behavior("test.liveEdits.Follow")
class Follow extends GameBehavior {
  @field(GameObject) target: GameObject | null = null;
  awake(): void {
    log.push(`awake ${this.node.name}`);
  }
  onDestroy(): void {
    log.push(`destroy ${this.node.name}`);
  }
}

const Health = defineComponent("test.liveEdits.Health", { hp: f32 });

let engine: Engine;
let world: World;

beforeEach(async () => {
  Input.reset();
  log.length = 0;
  engine = await Engine.create({ headless: true });
  world = engineWorld(engine, engine.world.name)!;
});

afterEach(() => engine.dispose());

const names = () => listNodes(world).filter((n) => n.depth > 0).map((n) => `${"  ".repeat(n.depth - 1)}${n.name}`);

describe("live nodes", () => {
  it("creates at the top level, as a child, and beside a row; renames", () => {
    const a = createLiveNode(world, null, undefined, "A");
    expect(a.parent).toBe(topLevelOf(world));
    const child = createLiveNode(world, a, undefined, "Child");
    const b = createLiveNode(world, null, undefined, "B");
    createLiveSibling(a, "AfterA");
    expect(names()).toEqual(["A", "  Child", "AfterA", "B"]);
    expect(child.parent).toBe(a);
    expect(b.world).toBe(world);
    expect(renameLive(child, "  Kid ")).toBe(true);
    expect(child.name).toBe("Kid");
    expect(renameLive(child, "   ")).toBe(false);
  });

  it("deletes a subtree at once, running its scripts' onDestroy", () => {
    const a = createLiveNode(world, null, undefined, "A");
    const c = createLiveNode(world, a, undefined, "C");
    c.addBehavior(Follow);
    expect(deleteLive(a)).toBeNull();
    expect(a.isValid).toBe(false);
    expect(c.isValid).toBe(false);
    expect(log).toContain("destroy C");
    expect(names()).toEqual([]);
    expect(whyNotDeleteLive(world.root)).toBe("it's the World root");
    expect(whyNotDeleteLive(a)).toBe("it has been destroyed");
  });

  it("reparents keeping the world position; refuses cycles, the root and scene nodes", () => {
    const a = createLiveNode(world, null, undefined, "A");
    const b = createLiveNode(world, null, undefined, "B");
    a.transform!.position.set(5, 0, 0);
    b.transform!.position.set(1, 2, 0);
    world._propagateTransforms();
    expect(moveLive(b, a)).toBeNull();
    expect(b.parent).toBe(a);
    world._propagateTransforms();
    expect(b.transform!.worldPosition.toArray()).toEqual([1, 2, 0]);
    expect(whyNotMoveLive(a, b)).toBe("it can't go inside itself");
    expect(moveLive(a, a)).toBe("it can't go inside itself");
    expect(whyNotMoveLive(world.root, a)).toBe("it's the World root");
    expect(moveLive(b, null)).toBeNull();
    expect(b.parent).toBe(topLevelOf(world));
    const scene = instantiateDocument(world, { format: "myco.scene@1", nodes: [] }, "scenes/x.scene.json");
    expect(whyNotMoveLive(scene, a)).toBe("a loaded scene stays at the top of its World");
  });

  it("refuses a parent in another World", () => {
    engine.createWorld({ name: "Other" });
    const there = createLiveNode(engineWorld(engine, "Other")!, null, undefined, "There");
    const here = createLiveNode(world, null, undefined, "Here");
    expect(whyNotMoveLive(here, there)).toBe("nodes can't move between Worlds");
    expect(liveNodeChoices(world).map((c) => c.name)).not.toContain("There");
  });
});

describe("live components", () => {
  it("adds a behavior (awake runs) and a data component; refuses a second data component", () => {
    const a = createLiveNode(world, null, undefined, "A");
    const added = addLiveComponent(a, "test.liveEdits.Follow");
    expect(typeof added).toBe("object");
    expect(log).toEqual(["awake A"]);
    expect(a.getBehavior(Follow)).not.toBeNull();
    expect(typeof addLiveComponent(a, "test.liveEdits.Health")).toBe("object");
    expect(a.hasData(Health)).toBe(true);
    expect(addLiveComponent(a, "test.liveEdits.Health")).toBe("it already has a liveEdits.Health");
    expect(addLiveComponent(a, "engine.Transform")).toBe("Transform is managed by the engine");
  });

  it("removes a behavior at once (onDestroy runs) and a data component; never the Transform", () => {
    const a = createLiveNode(world, null, undefined, "A");
    a.addBehavior(Follow);
    a.addData(Health);
    const infos = listComponents(a);
    expect(whyNotRemoveLive(infos.find((c) => c.type === "engine.Transform")!)).toBe("every node has a Transform");
    expect(removeLiveComponent(a, infos.find((c) => c.type === "test.liveEdits.Follow")!)).toBeNull();
    expect(log).toContain("destroy A");
    expect(removeLiveComponent(a, infos.find((c) => c.type === "test.liveEdits.Health")!)).toBeNull();
    expect(listComponents(a).map((c) => c.type)).toEqual(["engine.Transform"]);
  });

  it("points a node reference at a live node of the same World, or None", () => {
    const a = createLiveNode(world, null, undefined, "A");
    const b = createLiveNode(world, null, undefined, "B");
    const follow = a.addBehavior(Follow);
    const info = () => listComponents(a).find((c) => c.type === "test.liveEdits.Follow")!;
    expect(liveNodeChoices(world).map((c) => c.name)).toEqual(["A", "B"]);
    expect(setLiveNodeRef(a, info(), "target", b)).toBeNull();
    expect(follow.target).toBe(b);
    expect(setLiveNodeRef(a, info(), "target", null)).toBeNull();
    expect(follow.target).toBeNull();
    deleteLive(b);
    expect(setLiveNodeRef(a, info(), "target", b)).toBe("that node has been destroyed");
  });
});
