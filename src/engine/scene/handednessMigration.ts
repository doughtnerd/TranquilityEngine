/**
 * Scene format 3 → 4 (ADR 0164): the engine moves to Unity's coordinates (left-handed, +Y up, +Z forward)
 * from right-handed with -Z forward. Mirroring a scene in z keeps its picture exactly: every position's z is
 * negated and every rotation quaternion `(x, y, z, w)` becomes `(-x, -y, z, w)`. So this migration negates
 * the z of Transform positions, maps Transform rotations, and mirrors the node-space vectors built-in
 * components store (table below), on nodes, prefab-instance overrides, added components and added nodes.
 * 2D content (z = 0, Z-only turns) comes through unchanged; cameras move from z = +10 to z = -10.
 *
 * Models aren't touched here: model import settings say which way a model faces (`facing`, ADR 0164).
 * Script components' own vector fields can't be known here; their authors mirror them.
 *
 * Pure and synchronous, so it runs wherever scene files are read (editor, game, server, rewrite CLI).
 */
import type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile } from "./SceneLoader";

const TRANSFORM = "engine.Transform";

/** Round for the file: 7 decimals, no -0. */
const tidy = (n: number) => Math.round(n * 1e7) / 1e7 + 0;

const isNumbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number");

/** A point or direction in node space, mirrored: z negated. Anything else unchanged. */
export function mirrorVector(value: unknown): unknown {
  return isNumbers(value, 3) ? [value[0], value[1], tidy(-value[2])] : value;
}

/** A rotation mirrored: quaternion `(x, y, z, w)` → `(-x, -y, z, w)`. Other forms (hand-written Euler) unchanged. */
export function mirrorRotation(value: unknown): unknown {
  return isNumbers(value, 4) ? [tidy(-value[0]), tidy(-value[1]), value[2], value[3]] : value;
}

/** A signed angle about the vertical axis (degrees or radians): a mirror reverses its turn, so it's negated. */
function mirrorTurn(value: unknown): unknown {
  return typeof value === "number" ? tidy(-value) : value;
}

/** Water waves: `direction` is degrees from +X towards +Z, so a mirror negates it. */
function mirrorWaves(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((w) => (w && typeof w === "object" && typeof (w as { direction?: unknown }).direction === "number" ? { ...w, direction: tidy(-(w as { direction: number }).direction) } : w));
}

type FieldMirror = (value: unknown) => unknown;

/** Built-in components' node-space fields, by component id. Sizes and lengths are symmetric and stay. */
const FIELDS: Readonly<Record<string, Readonly<Record<string, FieldMirror>>>> = (() => {
  const center = { center: mirrorVector };
  const anchors = { anchor: mirrorVector, connectedAnchor: mirrorVector };
  const axisJoint = { ...anchors, axis: mirrorVector };
  return {
    [TRANSFORM]: { position: mirrorVector, rotation: mirrorRotation },
    "engine.BoxCollider": center,
    "engine.SphereCollider": center,
    "engine.CapsuleCollider": center,
    "engine.MeshCollider": center,
    "engine.FixedJoint": anchors,
    "engine.HingeJoint": axisJoint,
    "engine.SliderJoint": axisJoint,
    "engine.BallJoint": axisJoint,
    "engine.RopeJoint": anchors,
    "engine.SpringJoint": anchors,
    "engine.AudioReverbZone": center,
    "engine.NavChunk": center,
    "engine.NavModifierVolume": center,
    "engine.NavResolutionVolume": center,
    "engine.NavGate": center,
    "engine.NavCostVolume": center,
    "engine.WaterSurface": { waves: mirrorWaves },
    // `ambisonicYaw` turned left for positive values in the right-handed world; it now turns right like every yaw.
    "engine.AudioSource": { ambisonicYaw: mirrorTurn },
  };
})();

/** A component field's value mirrored, if the table knows it. */
export function mirrorField(component: string, field: string, value: unknown): unknown {
  const f = FIELDS[component]?.[field];
  return f ? f(value) : value;
}

function migrateComponent(c: ComponentEntry): ComponentEntry {
  const fields = FIELDS[c.type];
  if (!fields || !c.data) return c;
  const data = { ...c.data };
  for (const [name, mirror] of Object.entries(fields)) if (name in data) data[name] = mirror(data[name]);
  return { ...c, data };
}

function migrateOverride(o: OverrideEntry): OverrideEntry {
  let out = o;
  if (o.component && o.field && "value" in o) out = { ...out, value: mirrorField(o.component, o.field, o.value) };
  if (o.addComponent) out = { ...out, addComponent: migrateComponent(o.addComponent) };
  if (o.addNodes) out = { ...out, addNodes: o.addNodes.map(migrateNode) };
  return out;
}

function migrateNode(n: NodeEntry): NodeEntry {
  const components = n.components?.map(migrateComponent);
  const overrides = n.overrides?.map(migrateOverride);
  return { ...n, ...(components ? { components } : {}), ...(overrides ? { overrides } : {}) };
}

/** The migration itself (registered by `SceneLoader` from version 3). */
export function migrateToUnityCoordinates(file: SceneFile): SceneFile {
  return { ...file, nodes: (file.nodes ?? []).map(migrateNode) };
}
