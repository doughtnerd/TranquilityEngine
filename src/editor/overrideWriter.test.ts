// The override writer (ADR 0287), the write side of the override fold: one table of path shapes (a plain node, an
// instance's root, a node inside it, a nested instance's root and a node inside that) × edit kinds, each written
// through the writer and read back through the fold (the document's resolved view, ADR 0280): "write, then fold,
// gives what was asked", and reverting or undoing gives the document back as it was. The prefab files are the
// shared override table's (src/engine/tests/overrideCases.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Assets } from "../engine";
import { FORMAT, PREFAB, prefabFiles } from "../engine/tests/overrideCases";
import type { ResolvedNode } from "../engine/scene/resolvedScene";
import { CommandStack, SceneDocument, sameTarget, type Command, type NodePath, type SceneFile } from "./document";
import { inheritedValue, isOverridden, writeAddComponent, writeAddNodes, writeProperty, writeRemoveComponent, writeRemoveNode, type OverrideProperty } from "./overrideWriter";

const A = "test.fold.A", B = "test.fold.B", C = "test.fold.C", D = "test.fold.D", T = "engine.Transform";

const SCENE: SceneFile = {
  format: FORMAT,
  nodes: [
    { id: "plain", name: "Plain", tags: ["p"], components: [{ type: T }, { type: A, data: { n: 1 } }, { type: D, data: { v: 1 } }, { type: B }] },
    { id: "inst", prefab: PREFAB },
  ],
};

let doc: SceneDocument;
let stack: CommandStack;
beforeEach(() => {
  Assets.addSource(Assets.fromObject(prefabFiles));
  doc = new SceneDocument(structuredClone(SCENE), "s.scene.json");
  stack = new CommandStack(doc);
});
afterEach(() => Assets.clearSources());

/** One path shape: a behaviour to switch and limit to Worlds, and a field to set. */
interface Shape {
  readonly name: string;
  readonly path: NodePath;
  readonly behaviour: { type: string; index: number };
  readonly field: { type: string; index: number; field: string; value: unknown };
  /** Behaviours in a new order, where the node has several of them. */
  readonly order?: string[];
}

const shapes: Shape[] = [
  { name: "a plain node", path: ["plain"], behaviour: { type: A, index: 0 }, field: { type: A, index: 0, field: "n", value: 5 } },
  { name: "an instance's root", path: ["inst"], behaviour: { type: A, index: 1 }, field: { type: D, index: 0, field: "v", value: 6 }, order: [B, A, A] },
  { name: "a node inside an instance", path: ["inst", "kid"], behaviour: { type: C, index: 0 }, field: { type: T, index: 0, field: "position", value: [1, 2, 3] } },
  { name: "a nested instance's root", path: ["inst", "nest"], behaviour: { type: A, index: 0 }, field: { type: A, index: 0, field: "n", value: 7 } },
  { name: "a node inside a nested instance", path: ["inst", "nest", "leaf"], behaviour: { type: B, index: 0 }, field: { type: B, index: 0, field: "n", value: 8 } },
];

/** The node at `path` as the fold makes it. */
const folded = (path: NodePath): ResolvedNode => doc.resolve().nodes.find((n) => sameTarget(n.path, path))!;
const behaviours = (n: ResolvedNode) => n.components.map((c) => c.type).filter((t) => t !== T && t !== D);
const component = (n: ResolvedNode, type: string, index: number) => n.components.filter((c) => c.type === type)[index];

/** `p` as the folded node shows it. */
function seen(path: NodePath, p: OverrideProperty): unknown {
  const n = folded(path);
  switch (p.kind) {
    case "name":
      return n.name;
    case "active":
      return n.active;
    case "tags":
      return n.tags;
    case "order":
      return behaviours(n);
    case "enabled":
      return component(n, p.type, p.index)?.enabled !== false;
    case "worlds":
      return component(n, p.type, p.index)?.worlds;
    case "field":
      return (component(n, p.type, p.index)?.data as Record<string, unknown> | undefined)?.[p.field];
  }
}

const run = (command: Command | null): void => {
  expect(command).not.toBeNull();
  stack.execute(command!);
};

/** The edit kinds: a property and the value to set it to on a shape. */
const kinds: { name: string; property: (s: Shape) => OverrideProperty; value: (s: Shape) => unknown }[] = [
  { name: "name", property: () => ({ kind: "name" }), value: () => "Renamed" },
  { name: "active flag", property: () => ({ kind: "active" }), value: () => false },
  { name: "tags", property: () => ({ kind: "tags" }), value: () => ["t1", "t2"] },
  { name: "switch", property: (s) => ({ kind: "enabled", ...s.behaviour }), value: () => false },
  { name: "Worlds", property: (s) => ({ kind: "worlds", ...s.behaviour }), value: () => ["client"] },
  { name: "field", property: (s) => ({ kind: "field", type: s.field.type, index: s.field.index, field: s.field.field }), value: (s) => s.field.value },
];

describe("write, then fold, gives what was asked (ADR 0287)", () => {
  for (const shape of shapes) {
    const inside = shape.path[0] === "inst";
    for (const kind of kinds) {
      it(`${kind.name} of ${shape.name}`, () => {
        const before = doc.toJSON();
        const p = kind.property(shape), value = kind.value(shape);
        const command = writeProperty(doc, shape.path, p, value);
        run(command);
        expect(seen(shape.path, p)).toEqual(value);
        // An override inside an instance; a plain node's entry, or an instance root's own name, flag and tags.
        const asOverride = inside && (shape.path.length > 1 || !["name", "active", "tags"].includes(p.kind));
        expect(isOverridden(doc, shape.path, p)).toBe(asOverride || (p.kind === "tags" && inside));
        expect(stack.undo()).toBe(true);
        expect(doc.toJSON()).toEqual(before);
        if (!asOverride) return;
        // Reverting takes the override out, and with nothing left in it, the override goes.
        run(writeProperty(doc, shape.path, p, value));
        run(writeProperty(doc, shape.path, p, undefined));
        expect(doc.toJSON()).toEqual(before);
        expect(isOverridden(doc, shape.path, p)).toBe(false);
      });
    }

    it(`writing the prefab's own value is a revert: ${shape.name}`, () => {
      if (!inside) return;
      const before = doc.toJSON();
      for (const kind of kinds.filter((k) => k.name !== "field")) {
        const p = kind.property(shape);
        if (shape.path.length === 1 && ["name", "active", "tags"].includes(p.kind)) continue;
        const inherited = inheritedValue(doc, shape.path, p);
        run(writeProperty(doc, shape.path, p, kind.value(shape)));
        run(writeProperty(doc, shape.path, p, inherited));
        expect(seen(shape.path, p), kind.name).toEqual(inherited);
      }
      expect(doc.toJSON()).toEqual(before);
    });

    it(`adding and removing a component: ${shape.name}`, () => {
      const before = doc.toJSON();
      run(writeAddComponent(doc, shape.path, { type: C, data: {} }));
      const n = folded(shape.path);
      expect(behaviours(n).at(-1)).toBe(C);
      const added = n.components.filter((c) => c.type === C).length - 1;
      // Removing the one added here drops what added it.
      run(writeRemoveComponent(doc, shape.path, C, added));
      expect(doc.toJSON()).toEqual(before);
      // Removing one the node already has.
      const first = behaviours(folded(shape.path))[0];
      const count = behaviours(folded(shape.path)).length;
      run(writeRemoveComponent(doc, shape.path, first, 0));
      expect(behaviours(folded(shape.path))).toHaveLength(count - 1);
    });

    if (shape.order) {
      it(`order of ${shape.name}, and back to the prefab's order drops it`, () => {
        const before = doc.toJSON();
        run(writeProperty(doc, shape.path, { kind: "order" }, shape.order));
        expect(behaviours(folded(shape.path))).toEqual(shape.order);
        run(writeProperty(doc, shape.path, { kind: "order" }, inheritedValue(doc, shape.path, { kind: "order" })));
        expect(doc.toJSON()).toEqual(before);
      });
    }

    if (shape.path.length > 1) {
      it(`adding and removing nodes: ${shape.name}`, () => {
        const before = doc.toJSON();
        run(writeAddNodes(doc, shape.path, [{ id: "extra", name: "Extra", components: [{ type: T }] }, { id: "sub", name: "Sub", parent: "extra" }], "Add"));
        const extra = doc.resolve().nodes.find((n) => n.name === "Extra")!;
        expect(extra.parent).toBe(folded(shape.path).id);
        expect(doc.resolve().nodes.some((n) => n.name === "Sub")).toBe(true);
        run(writeRemoveNode(doc, extra.path));
        expect(doc.toJSON()).toEqual(before);
        run(writeRemoveNode(doc, shape.path));
        expect(doc.resolve().nodes.some((n) => sameTarget(n.path, shape.path))).toBe(false);
      });
    }
  }
});

describe("the writer and overrides it didn't write", () => {
  it("takes one property out of an override that sets several, and drops it once it sets nothing", () => {
    doc.node("inst").overrides = [{ target: ["kid"], name: "X", active: false }];
    expect(isOverridden(doc, ["inst", "kid"], { kind: "name" })).toBe(true);
    expect(isOverridden(doc, ["inst", "kid"], { kind: "active" })).toBe(true);
    run(writeProperty(doc, ["inst", "kid"], { kind: "name" }, "Y"));
    expect(doc.overrides("inst")).toEqual([{ target: ["kid"], name: "Y", active: false }]);
    run(writeProperty(doc, ["inst", "kid"], { kind: "name" }, undefined));
    expect(doc.overrides("inst")).toEqual([{ target: ["kid"], active: false }]);
    run(writeProperty(doc, ["inst", "kid"], { kind: "active" }, undefined));
    expect(doc.node("inst").overrides).toBeUndefined();
  });

  it("sets the value in the override the fold applies last and takes it out of earlier ones", () => {
    doc.node("inst").overrides = [{ target: ["kid"], tags: ["a"], name: "N" }, { target: ["kid"], tags: ["b"] }];
    run(writeProperty(doc, ["inst", "kid"], { kind: "tags" }, ["c"]));
    expect(doc.overrides("inst")).toEqual([{ target: ["kid"], name: "N" }, { target: ["kid"], tags: ["c"] }]);
    expect(seen(["inst", "kid"], { kind: "tags" })).toEqual(["c"]);
  });

  it("removing a prefab component drops its overrides and renumbers the later ones, which come after the removal", () => {
    doc.node("inst").overrides = [{ component: A, field: "n", value: 3 }, { component: A, index: 1, field: "n", value: 4 }, { component: A, index: 1, enabled: false }];
    run(writeRemoveComponent(doc, ["inst"], A, 0));
    expect(doc.overrides("inst")).toEqual([{ removeComponent: A }, { component: A, field: "n", value: 4 }, { component: A, enabled: false }]);
    const root = folded(["inst"]);
    expect(component(root, A, 0)).toMatchObject({ data: { n: 4 }, enabled: false });
  });

  it("an added component's switch goes on its own entry and keeps its Worlds", () => {
    run(writeAddComponent(doc, ["inst", "kid"], { type: C, worlds: ["client"], data: {} }));
    run(writeProperty(doc, ["inst", "kid"], { kind: "enabled", type: C, index: 1 }, false));
    expect(doc.overrides("inst")).toEqual([{ target: ["kid"], addComponent: { type: C, enabled: false, worlds: ["client"], data: {} } }]);
    expect(isOverridden(doc, ["inst", "kid"], { kind: "enabled", type: C, index: 1 })).toBe(false);
    run(writeProperty(doc, ["inst", "kid"], { kind: "enabled", type: C, index: 1 }, true));
    expect(doc.overrides("inst")).toEqual([{ target: ["kid"], addComponent: { type: C, worlds: ["client"], data: {} } }]);
  });

  it("writes nothing where the file doesn't have the component, or a plain node's order", () => {
    expect(writeProperty(doc, ["inst", "kid"], { kind: "enabled", type: A, index: 0 }, false)).toBeNull();
    expect(writeProperty(doc, ["plain"], { kind: "order" }, [B, A])).toBeNull();
    expect(writeRemoveComponent(doc, ["plain"], C, 0)).toBeNull();
    expect(writeProperty(doc, ["inst", "kid"], { kind: "name" }, undefined)).toBeNull();
  });
});
