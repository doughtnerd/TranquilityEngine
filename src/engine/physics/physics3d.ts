/**
 * 3D physics entry points that don't need Rapier loaded (ADR 0045): the event buffers, the
 * fixed-step systems, and `ensurePhysics3D`, which loads Rapier 3D (and `Physics3DWorld`) the
 * first time a World needs it, so games without 3D physics never download it.
 */
import { defineBuffer } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import { loadSceneFile } from "../scene/SceneLoader";
import type { Collider } from "./Collider";
import type { Physics3DWorld } from "./Physics3DWorld";

/** 3D physics events for systems (ADR 0017), like the 2D ones. Filled during fixed steps, cleared at end of frame. */
export interface PhysicsEvent {
  readonly a: Collider;
  readonly b: Collider;
  readonly started: boolean;
}
export const TriggerEvents = defineBuffer<PhysicsEvent>("engine.TriggerEvents");
export const CollisionEvents = defineBuffer<PhysicsEvent>("engine.CollisionEvents");

/** Component types that need a 3D physics world. */
export const PHYSICS_3D_TYPES: ReadonlySet<string> = new Set(["engine.RigidBody", "engine.BoxCollider", "engine.SphereCollider", "engine.CapsuleCollider", "engine.MeshCollider"]);

/** @internal True if a scene file (or a prefab it instances) has a 3D body or collider. */
export function usesPhysics3D(path: string, seen = new Set<string>()): boolean {
  if (seen.has(path)) return false;
  seen.add(path);
  let file;
  try {
    file = loadSceneFile(path);
  } catch {
    return false;
  }
  return file.nodes.some((n) => (n.components ?? []).some((c) => PHYSICS_3D_TYPES.has(c.type)) || (n.prefab !== undefined && usesPhysics3D(n.prefab, seen)));
}

let loading: Promise<typeof import("./Physics3DWorld")> | null = null;

/** @internal Create the World's 3D physics world, loading Rapier 3D's WASM once. */
export async function ensurePhysics3D(world: World): Promise<Physics3DWorld> {
  const mod = await (loading ??= import("./Physics3DWorld").then(async (m) => (await m.initRapier3D(), m)));
  if (!world.physics3D) world.physics3D = new mod.Physics3DWorld(world);
  return world.physics3D;
}

// The fixed-step 3D physics systems, after the 2D ones (ADR 0011): catalog entries for every World,
// doing nothing in a World without a 3D physics world (ADR 0032).
defineBuiltinSystem({ name: "engine.Physics3DPush", phase: "fixedUpdate", after: ["engine.PhysicsEvents"], run: (w) => w.physics3D?.push() });
defineBuiltinSystem({ name: "engine.Physics3DStep", phase: "fixedUpdate", after: ["engine.Physics3DPush"], run: (w, dt) => w.physics3D?.step(dt) });
defineBuiltinSystem({ name: "engine.Physics3DWriteBack", phase: "fixedUpdate", after: ["engine.Physics3DStep"], run: (w) => w.physics3D?.writeBack() });
defineBuiltinSystem({ name: "engine.Physics3DEvents", phase: "fixedUpdate", after: ["engine.Physics3DWriteBack"], run: (w) => w.physics3D?.dispatchEvents() });
