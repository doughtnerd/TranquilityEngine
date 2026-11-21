// The table of prefab-override cases (ADR 0280) that every adapter of the override fold is tested
// against: the resolved view and instantiation (overrideFold.test.ts), and the editor's Apply
// (prefabApplyFold.test.ts). Each case is an instance of `p.prefab.json` with some overrides and
// what the game should end up with, by node name (every node in these files has its own name).
import { expect } from "vitest";
import { GameBehavior, GameObject, behavior, defineComponent, f32, field } from "../index";
import { resolveScene, type ResolvedComponent } from "../scene/resolvedScene";
import type { NodeEntry, OverrideEntry } from "../scene/SceneLoader";

@behavior("test.fold.A")
export class FoldA extends GameBehavior {
  @field(Number) n = 0;
  @field(GameObject) ref: GameObject | null = null;
}
@behavior("test.fold.B")
export class FoldB extends GameBehavior {
  @field(Number) n = 0;
}
@behavior("test.fold.C")
export class FoldC extends GameBehavior {}
export const FoldD = defineComponent("test.fold.D", { v: f32 });

const A = "test.fold.A", B = "test.fold.B", C = "test.fold.C", D = "test.fold.D", T = "engine.Transform";

export const FORMAT = "myco.scene@4";

/** The prefab files every case instances (`p.prefab.json` nests `q.prefab.json`). */
export const prefabFiles: Record<string, { format: string; nodes: NodeEntry[] }> = {
  "prefabs/p.prefab.json": {
    format: FORMAT,
    nodes: [
      { id: "root", name: "Root", components: [{ type: T }, { type: D, data: { v: 1 } }, { type: A, data: { n: 1 } }, { type: B }, { type: A, data: { n: 2 } }] },
      { id: "kid", name: "Kid", parent: "root", tags: ["k"], components: [{ type: T }, { type: C }] },
      { id: "nest", parent: "root", prefab: "prefabs/q.prefab.json" },
    ],
  },
  "prefabs/q.prefab.json": {
    format: FORMAT,
    nodes: [
      { id: "qroot", name: "QRoot", components: [{ type: T }, { type: A, data: { n: 10 } }] },
      { id: "leaf", name: "Leaf", parent: "qroot", components: [{ type: T }, { type: B }] },
    ],
  },
};

export const PREFAB = "prefabs/p.prefab.json";

/** What one node should be. Omitted keys aren't checked. */
export interface NodeExpectation {
  parent?: string | null;
  active?: boolean;
  tags?: string[];
  /** Behaviours (scripts and engine components) in order. */
  behaviours?: string[];
  /** Data components, in any order. */
  data?: string[];
  /** `[type, index, field, value]`: a behaviour field or a data component field. */
  fields?: [string, number, string, unknown][];
  /** `[type, index, enabled]` for behaviours. */
  enabled?: [string, number, boolean][];
}

export interface OverrideCase {
  name: string;
  overrides: OverrideEntry[];
  /** By node name. */
  nodes: Record<string, NodeExpectation>;
  /** Names that must not be there. */
  absent?: string[];
}

const base: Record<string, NodeExpectation> = {
  Root: { parent: null, behaviours: [A, B, A], data: [D], fields: [[A, 0, "n", 1], [A, 1, "n", 2], [D, 0, "v", 1]] },
  Kid: { parent: "Root", active: true, tags: ["k"], behaviours: [C] },
  QRoot: { parent: "Root", behaviours: [A], fields: [[A, 0, "n", 10]] },
  Leaf: { parent: "QRoot", behaviours: [B] },
};

export const overrideCases: OverrideCase[] = [
  { name: "no overrides", overrides: [], nodes: base },
  {
    name: "an inner node's name, active flag and tags",
    overrides: [{ target: ["kid"], name: "Kid2" }, { target: ["kid"], active: false }, { target: ["kid"], tags: ["x", "y"] }],
    nodes: { Kid2: { parent: "Root", active: false, tags: ["x", "y"], behaviours: [C] } },
    absent: ["Kid"],
  },
  {
    name: "removeComponent takes the first of its type, and index counts what is left",
    overrides: [{ removeComponent: A }, { component: A, field: "n", value: 5 }],
    nodes: { Root: { behaviours: [B, A], fields: [[A, 0, "n", 5]] } },
  },
  {
    name: "addComponent appends, and index counts the added one",
    overrides: [{ addComponent: { type: B, data: { n: 3 } } }, { component: B, index: 1, enabled: false }, { component: B, index: 1, field: "n", value: 4 }],
    nodes: { Root: { behaviours: [A, B, A, B], enabled: [[B, 0, true], [B, 1, false]], fields: [[B, 1, "n", 4]] } },
  },
  {
    name: "order arranges behaviours only; Transform and data components keep their places",
    overrides: [{ order: [B, A] }],
    nodes: { Root: { behaviours: [B, A, A], data: [D], fields: [[A, 0, "n", 1], [A, 1, "n", 2]] } },
  },
  {
    name: "a switch and fields on the root, data component included",
    overrides: [{ component: A, index: 1, enabled: false }, { component: D, field: "v", value: 4 }],
    nodes: { Root: { enabled: [[A, 0, true], [A, 1, false]], fields: [[D, 0, "v", 4]] } },
  },
  {
    name: "targets into a nested instance and at its root",
    overrides: [
      { target: ["nest"], name: "Nest" },
      { target: ["nest"], component: A, field: "n", value: 11 },
      { target: ["nest", "leaf"], component: B, field: "n", value: 12 },
      { target: ["nest", "leaf"], tags: ["deep"] },
    ],
    nodes: { Nest: { parent: "Root", fields: [[A, 0, "n", 11]] }, Leaf: { parent: "Nest", tags: ["deep"], fields: [[B, 0, "n", 12]] } },
    absent: ["QRoot"],
  },
  {
    name: "removeNode on an inner node and inside a nested instance",
    overrides: [{ target: ["kid"], removeNode: true }, { target: ["nest", "leaf"], removeNode: true }],
    nodes: { Root: { behaviours: [A, B, A] }, QRoot: { parent: "Root" } },
    absent: ["Kid", "Leaf"],
  },
  {
    name: "addNodes under an inner node, with a nested prefab, which later overrides target",
    overrides: [
      { target: ["kid"], addNodes: [{ id: "extra", name: "Extra", components: [{ type: T }, { type: A, data: { n: 7 } }] }, { id: "sub", parent: "extra", prefab: "prefabs/q.prefab.json", name: "Sub" }] },
      { target: ["extra"], addComponent: { type: C } },
      { target: ["sub"], component: A, field: "n", value: 13 },
      { target: ["sub", "leaf"], name: "SubLeaf" },
    ],
    nodes: {
      Extra: { parent: "Kid", behaviours: [A, C], fields: [[A, 0, "n", 7]] },
      Sub: { parent: "Extra", behaviours: [A], fields: [[A, 0, "n", 13]] },
      SubLeaf: { parent: "Sub", behaviours: [B] },
      Leaf: { parent: "QRoot" },
    },
  },
  {
    name: "addNodes at a nested instance's root, targeted through it",
    overrides: [{ target: ["nest"], addNodes: [{ id: "inNest", name: "InNest", components: [{ type: T }] }] }, { target: ["nest", "inNest"], tags: ["t"] }],
    nodes: { InNest: { parent: "QRoot", tags: ["t"] } },
  },
];

/** What a test can see of one node, by whichever adapter made it. */
export interface Observed {
  parent: string | null;
  active: boolean;
  tags: string[];
  behaviours: string[];
  data: string[];
  field(type: string, index: number, field: string): unknown;
  enabled(type: string, index: number): boolean;
}

/** Check `seen` (by node name) against a case. */
export function expectCase(c: OverrideCase, seen: ReadonlyMap<string, Observed>): void {
  for (const [name, want] of Object.entries(c.nodes) as [string, NodeExpectation][]) {
    const got = seen.get(name);
    expect(got, `${c.name}: node "${name}"`).toBeDefined();
    if (want.parent !== undefined) expect(got!.parent, `${c.name}: ${name} parent`).toBe(want.parent);
    if (want.active !== undefined) expect(got!.active, `${c.name}: ${name} active`).toBe(want.active);
    if (want.tags !== undefined) expect(got!.tags, `${c.name}: ${name} tags`).toEqual(want.tags);
    if (want.behaviours !== undefined) expect(got!.behaviours, `${c.name}: ${name} behaviours`).toEqual(want.behaviours);
    if (want.data !== undefined) expect([...got!.data].sort(), `${c.name}: ${name} data`).toEqual([...want.data].sort());
    for (const [type, index, field, value] of want.fields ?? []) expect(got!.field(type, index, field), `${c.name}: ${name} ${type}[${index}].${field}`).toEqual(value);
    for (const [type, index, on] of want.enabled ?? []) expect(got!.enabled(type, index), `${c.name}: ${name} ${type}[${index}] enabled`).toBe(on);
  }
  for (const name of c.absent ?? []) expect(seen.has(name), `${c.name}: "${name}" should be gone`).toBe(false);
}

const DATA = new Set(["test.fold.D"]);

/** The resolved view's nodes of a scene, as `Observed` by name. */
export function observeResolved(path: string, read: (path: string) => unknown): Map<string, Observed> {
  const { nodes } = resolveScene(path, { read });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, Observed>();
  for (const n of nodes) {
    const of = (type: string, index: number): ResolvedComponent | undefined => n.components.filter((c) => c.type === type)[index];
    out.set(n.name ?? n.id, {
      parent: n.parent === undefined ? null : (byId.get(n.parent)?.name ?? n.parent),
      active: n.active,
      tags: n.tags ?? [],
      behaviours: n.components.map((c) => c.type).filter((t) => t !== "engine.Transform" && !DATA.has(t)),
      data: n.components.map((c) => c.type).filter((t) => DATA.has(t)),
      field: (type, index, field) => (of(type, index)?.data as Record<string, unknown> | undefined)?.[field],
      enabled: (type, index) => of(type, index)?.enabled !== false,
    });
  }
  return out;
}

