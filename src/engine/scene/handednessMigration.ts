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
 * The walk over the file is `sceneFileWalk.ts` (ADR 0279). Pure and synchronous, so it runs wherever scene files are read (editor, game, server, rewrite CLI).
 */
import type { SceneFile } from "./SceneLoader";
import { isNumberTuple, mapSceneFile, tidyNumber } from "./sceneFileWalk";

const TRANSFORM = "engine.Transform";

/** A point or direction in node space, mirrored: z negated. Anything else unchanged. */
function mirrorVector(value: unknown): unknown {
  return isNumberTuple(value, 3) ? [value[0], value[1], tidyNumber(-value[2])] : value;
}

/** A rotation mirrored: quaternion `(x, y, z, w)` → `(-x, -y, z, w)`. Other forms (hand-written Euler) unchanged. */
function mirrorRotation(value: unknown): unknown {
  return isNumberTuple(value, 4) ? [tidyNumber(-value[0]), tidyNumber(-value[1]), value[2], value[3]] : value;
}

/** A signed angle about the vertical axis (degrees or radians): a mirror reverses its turn, so it's negated. */
function mirrorTurn(value: unknown): unknown {
  return typeof value === "number" ? tidyNumber(-value) : value;
}

/** Water waves: `direction` is degrees from +X towards +Z, so a mirror negates it. */
function mirrorWaves(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((w) => (w && typeof w === "object" && typeof (w as { direction?: unknown }).direction === "number" ? { ...w, direction: tidyNumber(-(w as { direction: number }).direction) } : w));
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
function mirrorField(component: string, field: string, value: unknown): unknown {
  const f = FIELDS[component]?.[field];
  return f ? f(value) : value;
}

/** The migration itself (registered by `SceneLoader` from version 3). */
export function migrateToUnityCoordinates(file: SceneFile): SceneFile {
  return mapSceneFile(file, { field: mirrorField });
}
