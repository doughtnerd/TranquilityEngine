// The node kinds the Create menus offer (ADR 0022, 0146): an empty node, a sprite, a camera, a 3D shape
// (with a matching collider, as in Unity), a light (ADR 0043), a UI Document (ADR 0077, 0417) or a kind a plugin adds
// (Particle System, Tilemap), each as a node template. The node insertion (ADR 0246, `nodeInsertion.ts`) puts them
// in the scene.
import { createAsset } from "./assetKindHost";
import { registeredKind } from "./assetKindLookup";
import { hierarchyCreateEntries, type HierarchyCreateContribution, type NodeTemplate } from "./sdk/contributions";
import { WATER_PRESET } from "../engine/render/water/gerstner";
import { OTHER_CATEGORY } from "./menuCategories";

/** The editor's own node kinds. */
export type NewNodeKind = "empty" | "sprite" | "camera" | Shape3D | `${LightKind}-light` | "fog" | "reflection-probe" | "water" | "ui-document";
/** A built-in node kind, or the id of a plugin's Hierarchy create entry (ADR 0146). */
export type NodeKind = NewNodeKind | (string & {});
type Shape3D = "cube" | "sphere" | "capsule" | "cylinder" | "plane";
type LightKind = "directional" | "point" | "spot" | "ambient";

type Vec3 = readonly [number, number, number];

/**
 * A kind the Create menus offer: its label, the new node's base name, and where the menus put it (ADR 0383): its
 * `category` submenu ("3D Object", "Light"; none: the top level).
 */
export interface CreatableKind {
  readonly kind: NodeKind;
  readonly label: string;
  readonly name: string;
  readonly category?: string;
}

/** The editor's own kinds, in menu order, with their base names. Plugins' kinds join them in `newNodeKinds()`. */
const NEW_NODE_KINDS: readonly (CreatableKind & { kind: NewNodeKind })[] = [
  { kind: "empty", label: "Empty", name: "Node" },
  { kind: "sprite", label: "Sprite", name: "Sprite", category: "2D" },
  { kind: "camera", label: "Camera", name: "Camera" },
  { kind: "cube", label: "Cube", name: "Cube", category: "3D Object" },
  { kind: "sphere", label: "Sphere", name: "Sphere", category: "3D Object" },
  { kind: "capsule", label: "Capsule", name: "Capsule", category: "3D Object" },
  { kind: "cylinder", label: "Cylinder", name: "Cylinder", category: "3D Object" },
  { kind: "plane", label: "Plane", name: "Plane", category: "3D Object" },
  { kind: "directional-light", label: "Directional Light", name: "Directional Light", category: "Light" },
  { kind: "point-light", label: "Point Light", name: "Point Light", category: "Light" },
  { kind: "spot-light", label: "Spot Light", name: "Spot Light", category: "Light" },
  { kind: "ambient-light", label: "Ambient Light", name: "Ambient Light", category: "Light" },
  { kind: "fog", label: "Fog", name: "Fog", category: "Effects" },
  { kind: "reflection-probe", label: "Reflection Probe", name: "Reflection Probe", category: "Light" },
  { kind: "water", label: "Water", name: "Water", category: "Effects" },
  { kind: "ui-document", label: "UI Document", name: "UI Document", category: "UI" },
];

/**
 * The kinds the Create menu offers, in menu order: the built-in ones, with each plugin's entry (registration
 * order) after the entry its `after` names, or last. A plugin's entry goes in the category it names, else in the
 * category of the entry it follows, else in Other (ADR 0383). Reads the registry's version, so menus follow plugins.
 */
export function newNodeKinds(): readonly CreatableKind[] {
  void hierarchyCreateEntries.version.value;
  const out: CreatableKind[] = [...NEW_NODE_KINDS];
  for (const c of hierarchyCreateEntries.list()) {
    const at = c.after === undefined ? -1 : out.findIndex((k) => k.kind === c.after);
    const category = c.category || (at < 0 ? undefined : out[at]!.category) || OTHER_CATEGORY;
    out.splice(at < 0 ? out.length : at + 1, 0, { kind: c.id, label: c.label, name: c.name, category });
  }
  return out;
}

/** A plugin's create entry for `kind`, if `kind` isn't built in. */
export function contributedKind(kind: NodeKind): HierarchyCreateContribution | undefined {
  return NEW_NODE_KINDS.some((k) => k.kind === kind) ? undefined : hierarchyCreateEntries.get(kind);
}

/** The collider each 3D shape comes with. */
const SHAPE_COLLIDERS: Record<Shape3D, { type: string; data: Record<string, unknown> }> = {
  cube: { type: "engine.BoxCollider", data: {} },
  sphere: { type: "engine.SphereCollider", data: {} },
  capsule: { type: "engine.CapsuleCollider", data: {} },
  cylinder: { type: "engine.CapsuleCollider", data: {} },
  plane: { type: "engine.MeshCollider", data: {} },
};

/**
 * The template for a new node of `kind` at `position` in its parent's space (ADR 0246): its base name and
 * components; the node insertion mints the id and makes the name unique. `topLevel` puts a camera in front of the
 * sprite plane and raises a sun. `asset` is the `asset:<path>` the node uses (a UI Document's markup, a plugin
 * kind's effect or tileset), or "". Null for a kind nothing registers (its plugin is off).
 */
export function kindTemplate(kind: NodeKind, position: Vec3, topLevel: boolean, asset = ""): NodeTemplate | null {
  const contributed = contributedKind(kind);
  const info = contributed ?? NEW_NODE_KINDS.find((k) => k.kind === kind);
  if (!info) return null;
  const name = info.name;
  const at: [number, number, number] = [position[0], position[1], position[2]];
  if (contributed) return { name, components: contributed.components(at, asset) };
  const builtin = kind as NewNodeKind;
  switch (builtin) {
    case "empty":
      return { name, components: [{ type: "engine.Transform", data: { position: at } }] };
    case "sprite":
      return { name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.SpriteRenderer", data: {} }] };
    case "camera":
      // In front of the sprite plane, looking along +z like the sample scenes' cameras (ADR 0164).
      return {
        name,
        components: [
          { type: "engine.Transform", data: { position: [at[0], at[1], topLevel ? -10 : at[2]] } },
          { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 5 } },
        ],
      };
    case "cube":
    case "sphere":
    case "capsule":
    case "cylinder":
    case "plane":
      return {
        name,
        components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.MeshRenderer", data: { mesh: `builtin:${builtin}` } }, structuredClone(SHAPE_COLLIDERS[builtin])],
      };
    case "fog":
      return { name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.Fog", data: {} }] };
    case "reflection-probe":
      return { name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.ReflectionProbe", data: {} }] };
    case "water":
      // A WaterSurface with the four-wave preset written out, so the inspector's wave list shows it (ADR 0072).
      return { name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.WaterSurface", data: { waves: WATER_PRESET.map((w) => ({ ...w })) } }] };
    case "ui-document":
      // A markup document (ADR 0077): `asset` is the new `.ui.xml` written first (`kindAssetCreator`), or empty.
      return { name, components: [{ type: "engine.Transform", data: { position: at } }, { type: "engine.UIDocument", data: asset ? { document: asset } : {} }] };
    default: {
      // A light: directional and spot lights point down and away, like a sun in the afternoon
      // (a -30-degree yaw, then pitched 50 degrees down about the world X axis; a quaternion, ADR 0163, 0164).
      const type = builtin.replace(/-light$/, "");
      const aimed = type === "directional" || type === "spot";
      const position = type === "directional" && topLevel ? [at[0], at[1] + 5, at[2]] : at;
      return {
        name,
        components: [
          { type: "engine.Transform", data: aimed ? { position, rotation: [0.4082179, -0.2345697, -0.1093817, 0.8754261] } : { position } },
          { type: "engine.Light", data: { type } },
        ],
      };
    }
  }
}

/**
 * The asset a new node of `kind` needs written first, if any (ADR 0146, 0246): a contributed kind's `createAsset`
 * (a Particle System's effect), or for UI Document a new document from the `uidocument` asset kind's `create`
 * (ADR 0077, 0149) when the UI plugin registers one. Resolves to the new file's path, or null when it couldn't
 * write one (it said why in the status).
 */
export function kindAssetCreator(kind: NodeKind): (() => Promise<string | null>) | undefined {
  const contributed = contributedKind(kind);
  if (contributed) return contributed.createAsset && (() => contributed.createAsset!());
  if (kind === "ui-document" && registeredKind("uidocument")?.create) return () => createAsset("uidocument");
  return undefined;
}
