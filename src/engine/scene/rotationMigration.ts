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
 * The walk over the file is `sceneFileWalk.ts` (ADR 0279). Pure and synchronous, so it runs wherever scene files are read (editor, game, server, rewrite CLI).
 */
import { DEG2RAD, Quaternion } from "../core/math";
import type { SceneFile } from "./SceneLoader";
import { isNumberTuple, mapSceneFile, tidyNumber } from "./sceneFileWalk";

const TRANSFORM = "engine.Transform";

/** A version 2 Transform rotation as a version 3 quaternion array; anything else unchanged. */
function rotationToQuaternion(value: unknown): unknown {
  let q: Quaternion;
  if (typeof value === "number") q = Quaternion.rotateZ(value * DEG2RAD);
  else if (isNumberTuple(value, 3)) q = Quaternion.euler(value[0] * DEG2RAD, value[1] * DEG2RAD, value[2] * DEG2RAD, "ZYX");
  else return value;
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w); // the same rotation; keep w ≥ 0 so files read alike
  return q.toArray().map(tidyNumber);
}

/** The migration itself (registered by `SceneLoader` from version 2). */
export function migrateRotationsToQuaternions(file: SceneFile): SceneFile {
  return mapSceneFile(file, { field: (component, field, value) => (component === TRANSFORM && field === "rotation" ? rotationToQuaternion(value) : value) });
}
