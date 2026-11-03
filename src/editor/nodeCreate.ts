// Creating new nodes from the hierarchy (ADR 0022, 0026): an empty node, a sprite, a camera, a
// text, a 3D shape (with a matching collider, as in Unity) or a light (ADR 0043), at the top of
// the scene, beside a node or under it. Each is one undo step.
import { uniqueId } from "./assetBrowser";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import type { OpenScene } from "./state";

export type NewNodeKind = "empty" | "sprite" | "camera" | "text" | Shape3D | `${LightKind}-light`;
type Shape3D = "cube" | "sphere" | "capsule" | "cylinder" | "plane";
type LightKind = "directional" | "point" | "spot" | "ambient";

type Vec3 = readonly [number, number, number];

/** The kinds the Create menu offers, in menu order, with their base names. */
export const NEW_NODE_KINDS: readonly { kind: NewNodeKind; label: string; name: string }[] = [
  { kind: "empty", label: "Empty", name: "Node" },
  { kind: "sprite", label: "Sprite", name: "Sprite" },
  { kind: "camera", label: "Camera", name: "Camera" },
  { kind: "text", label: "Text", name: "Text" },
  { kind: "cube", label: "Cube", name: "Cube" },
  { kind: "sphere", label: "Sphere", name: "Sphere" },
  { kind: "capsule", label: "Capsule", name: "Capsule" },
  { kind: "cylinder", label: "Cylinder", name: "Cylinder" },
  { kind: "plane", label: "Plane", name: "Plane" },
  { kind: "directional-light", label: "Directional Light", name: "Directional Light" },
  { kind: "point-light", label: "Point Light", name: "Point Light" },
  { kind: "spot-light", label: "Spot Light", name: "Spot Light" },
  { kind: "ambient-light", label: "Ambient Light", name: "Ambient Light" },
];

/** The collider each 3D shape comes with. */
const SHAPE_COLLIDERS: Record<Shape3D, { type: string; data: Record<string, unknown> }> = {
  cube: { type: "engine.BoxCollider", data: {} },
  sphere: { type: "engine.SphereCollider", data: {} },
  capsule: { type: "engine.CapsuleCollider", data: {} },
  cylinder: { type: "engine.CapsuleCollider", data: {} },
  plane: { type: "engine.MeshCollider", data: {} },
};

/** Display name of a node entry (its name, or its id). */
const nameOf = (doc: SceneDocument, id: string) => doc.node(id).name ?? id;

/**
 * `base`, or `base (1)`, `base (2)`… whichever none of `parent`'s children (null: the top level)
 * is called yet, so new and pasted nodes are told apart in the hierarchy.
 */
export function uniqueName(doc: SceneDocument, parent: string | null, base: string, taken: Iterable<string> = []): string {
  const names = new Set([...doc.children(parent).map((id) => nameOf(doc, id)), ...taken]);
  if (!names.has(base)) return base;
  const stem = base.replace(/ \(\d+\)$/, "");
  for (let n = 1; ; n++) if (!names.has(`${stem} (${n})`)) return `${stem} (${n})`;
}

/** The scene entry for a new node of `kind` under `parent`, at `position` in the parent's space. */
export function newNodeEntry(doc: SceneDocument, kind: NewNodeKind, parent: string | null, position: Vec3 = [0, 0, 0]): NodeEntry {
  const info = NEW_NODE_KINDS.find((k) => k.kind === kind)!;
  const id = uniqueId(doc, info.name.toLowerCase().replace(/ /g, "-"));
  const name = uniqueName(doc, parent, info.name);
  const at = [...position];
  switch (kind) {
    case "empty":
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }] };
    case "sprite":
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.SpriteRenderer", data: {} }] };
    case "camera":
      // In front of the sprite plane, looking down -z like the sample scenes' cameras.
      return {
        id,
        name,
        components: [
          { type: "engine.Transform", data: { position: [at[0], at[1], parent === null ? 10 : at[2]] } },
          { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 5 } },
        ],
      };
    case "text":
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.Text", data: { text: "New Text" } }] };
    case "cube":
    case "sphere":
    case "capsule":
    case "cylinder":
    case "plane":
      return {
        id,
        name,
        components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.MeshRenderer", data: { mesh: `builtin:${kind}` } }, structuredClone(SHAPE_COLLIDERS[kind])],
      };
    default: {
      // A light: directional and spot lights point down and away, like a sun in the afternoon.
      const type = kind.replace(/-light$/, "");
      const aimed = type === "directional" || type === "spot";
      const position = type === "directional" && parent === null ? [at[0], at[1] + 5, at[2]] : at;
      return {
        id,
        name,
        components: [
          { type: "engine.Transform", data: aimed ? { position, rotation: [-50, 30, 0] } : { position } },
          { type: "engine.Light", data: { type } },
        ],
      };
    }
  }
}

export interface CreateOptions {
  /** Parent node id; null or omitted for the top level. */
  parent?: string | null;
  /** Position among the parent's children; omitted: last. */
  index?: number;
  /** Where the node goes in its parent's space. */
  position?: Vec3;
}

/** Why a node can't be created under `parent`, or null if it can. */
export function whyNotCreatable(doc: SceneDocument, parent: string | null): string | null {
  if (parent === null) return null;
  if (parent.includes("/")) return "nodes inside a prefab get children in the prefab";
  if (!doc.has(parent)) return "that node is gone";
  return null;
}

/** Add a new node of `kind` to the open scene as one undo step. Returns its id. */
export function createNode(scene: OpenScene, kind: NewNodeKind, options: CreateOptions = {}): string {
  const parent = options.parent ?? null;
  const reason = whyNotCreatable(scene.doc, parent);
  if (reason) throw new Error(reason);
  const entry = newNodeEntry(scene.doc, kind, parent, options.position);
  scene.stack.beginGroup(`Create ${entry.name}`);
  try {
    scene.stack.execute(new AddNode(entry, { parent, index: options.index }));
  } finally {
    scene.stack.endGroup();
  }
  return entry.id;
}
