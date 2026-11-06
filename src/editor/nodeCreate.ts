// Creating new nodes from the hierarchy (ADR 0022, 0026): an empty node, a sprite, a camera, a
// text, a 3D shape (with a matching collider, as in Unity), a light (ADR 0043) or a UI element (ADR 0069), at the top of
// the scene, beside a node or under it. Each is one undo step.
import { uniqueId } from "./assetBrowser";
import { AddNode, type NodeEntry, type SceneDocument } from "./document";
import type { OpenScene } from "./state";
import { WATER_PRESET } from "../engine/render/water/gerstner";

export type NewNodeKind = "empty" | "sprite" | "camera" | "text" | Shape3D | `${LightKind}-light` | "fog" | "reflection-probe" | "particle-system" | "water" | `ui-${UIKind}` | "ui-document";
type Shape3D = "cube" | "sphere" | "capsule" | "cylinder" | "plane";
type LightKind = "directional" | "point" | "spot" | "ambient";
type UIKind = "canvas" | "panel" | "text" | "image" | "button" | "input-field";

/** Game UI elements (ADR 0069): the component each kind adds, with a starting size and look. */
const UI_ELEMENTS: Record<UIKind, { type: string; data: Record<string, unknown> }> = {
  canvas: { type: "engine.UICanvas", data: {} },
  panel: { type: "engine.UIPanel", data: { width: "200", height: "100", backgroundColor: "#2a2f3a" } },
  text: { type: "engine.UIText", data: { text: "New Text" } },
  image: { type: "engine.UIImage", data: { width: "100", height: "100" } },
  button: { type: "engine.UIButton", data: { width: "160", height: "40" } },
  "input-field": { type: "engine.UIInputField", data: { placeholder: "Enter text…" } },
};

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
  { kind: "fog", label: "Fog", name: "Fog" },
  { kind: "reflection-probe", label: "Reflection Probe", name: "Reflection Probe" },
  { kind: "particle-system", label: "Particle System", name: "Particle System" },
  { kind: "water", label: "Water", name: "Water" },
  { kind: "ui-canvas", label: "UI Canvas", name: "Canvas" },
  { kind: "ui-panel", label: "UI Panel", name: "Panel" },
  { kind: "ui-text", label: "UI Text", name: "Text" },
  { kind: "ui-image", label: "UI Image", name: "Image" },
  { kind: "ui-button", label: "UI Button", name: "Button" },
  { kind: "ui-input-field", label: "UI Input Field", name: "Input Field" },
  { kind: "ui-document", label: "UI Document", name: "UI Document" },
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
export function newNodeEntry(doc: SceneDocument, kind: NewNodeKind, parent: string | null, position: Vec3 = [0, 0, 0], effect = ""): NodeEntry {
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
    case "fog":
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.Fog", data: {} }] };
    case "reflection-probe":
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.ReflectionProbe", data: {} }] };
    case "water":
      // A WaterSurface with the four-wave preset written out, so the inspector's wave list shows it (ADR 0072).
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.WaterSurface", data: { waves: WATER_PRESET.map((w) => ({ ...w })) } }] };
    case "particle-system":
      // Effects are assets (ADR 0060): `effect` is a new one `createParticleSystemNode` made, or empty.
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.ParticleSystem", data: effect ? { effect } : {} }] };
    case "ui-document":
      // A markup document (ADR 0077): `effect` is the new `.ui.xml` `createNodeIn` made, or empty.
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.UIDocument", data: effect ? { document: effect } : {} }] };
    case "ui-canvas":
    case "ui-panel":
    case "ui-text":
    case "ui-image":
    case "ui-button":
    case "ui-input-field":
      return { id, name, components: [{ type: "engine.Transform", data: { position: at } }, structuredClone(UI_ELEMENTS[kind.slice(3) as UIKind])] };
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
  /** Particle System: the effect asset it plays; UI Document: its markup (`asset:<path>`). */
  effect?: string;
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
  const entry = newNodeEntry(scene.doc, kind, parent, options.position, options.effect);
  scene.stack.beginGroup(`Create ${entry.name}`);
  try {
    scene.stack.execute(new AddNode(entry, { parent, index: options.index }));
  } finally {
    scene.stack.endGroup();
  }
  return entry.id;
}
