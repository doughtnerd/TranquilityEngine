/**
 * Scene format 2 → 3 (ADR 0163): Transform rotations are stored as quaternions `[x, y, z, w]`, as Unity
 * ECS's `LocalTransform.Rotation`. Version 2 stored Euler degrees `[x, y, z]` applied X-outermost
 * (`q = qX · qY · qZ`, the order now called `"ZYX"`), or a single number for a 2D (Z) angle. Every
 * Transform `rotation`, on a node, in a prefab instance's override, an added component or an added node,
 * becomes the quaternion it meant, so scenes look exactly as before.
 *
 * `@field(Quaternion)` values are left alone: a whole-file migration can't tell them from other number
 * lists (per-component migrations are ADR 0123), and the loader still reads `[x, y, z]` as Euler degrees,
 * now in the default `"ZXY"` order, which agrees with the old reading whenever at most one axis is set.
 *
 * Pure and synchronous, so it runs wherever scene files are read (editor, game, server, rewrite CLI).
 */
import { DEG2RAD, Quaternion } from "../core/math";
import type { ComponentEntry, NodeEntry, OverrideEntry, SceneFile } from "./SceneLoader";

const TRANSFORM = "engine.Transform";

/** Round for the file: 7 decimals, no -0. */
const tidy = (n: number) => Math.round(n * 1e7) / 1e7 + 0;

/** A version 2 Transform rotation as a version 3 quaternion array; anything else unchanged. */
export function rotationToQuaternion(value: unknown): unknown {
  let q: Quaternion;
  if (typeof value === "number") q = Quaternion.rotateZ(value * DEG2RAD);
  else if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number")) q = Quaternion.euler(value[0] * DEG2RAD, value[1] * DEG2RAD, value[2] * DEG2RAD, "ZYX");
  else return value;
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w); // the same rotation; keep w ≥ 0 so files read alike
  return q.toArray().map(tidy);
}

function migrateComponent(c: ComponentEntry): ComponentEntry {
  if (c.type !== TRANSFORM || !c.data || !("rotation" in c.data)) return c;
  return { ...c, data: { ...c.data, rotation: rotationToQuaternion(c.data.rotation) } };
}

function migrateOverride(o: OverrideEntry): OverrideEntry {
  let out = o;
  if (o.component === TRANSFORM && o.field === "rotation") out = { ...out, value: rotationToQuaternion(o.value) };
  if (o.addComponent) out = { ...out, addComponent: migrateComponent(o.addComponent) };
  if (o.addNodes) out = { ...out, addNodes: o.addNodes.map(migrateNode) };
  return out;
}

function migrateNode(n: NodeEntry): NodeEntry {
  const components = n.components?.map(migrateComponent);
  const overrides = n.overrides?.map(migrateOverride);
  return { ...n, ...(components ? { components } : {}), ...(overrides ? { overrides } : {}) };
}

/** The migration itself (registered by `SceneLoader` from version 2). */
export function migrateRotationsToQuaternions(file: SceneFile): SceneFile {
  return { ...file, nodes: (file.nodes ?? []).map(migrateNode) };
}
