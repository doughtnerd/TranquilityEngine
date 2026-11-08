/**
 * 3D physics entry points that don't need a backend loaded (ADR 0045, 0135, 0137): the event buffers,
 * the Component types that start the World service, the service itself (which loads the shared core and
 * the 3D backend the first time a World needs them, so games without 3D physics never download it) and
 * the fixed-step systems.
 */
import { defineBuffer } from "../../../engine/core/data";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import type { Collider } from "./Collider";
import type { PhysicsBackend3D } from "./backend";
import type { PhysicsWorld3D } from "./core/PhysicsWorld3D";
import { physicsWorldService } from "./services";

/** 3D physics events for systems (ADR 0017), like the 2D ones. Filled during fixed steps, cleared at end of frame. */
export interface PhysicsEvent {
  readonly a: Collider;
  readonly b: Collider;
  readonly started: boolean;
}
export const TriggerEvents = defineBuffer<PhysicsEvent>("engine.TriggerEvents");
export const CollisionEvents = defineBuffer<PhysicsEvent>("engine.CollisionEvents");

/** The World service's id (ADR 0135; it kept its name when the 2D and 3D plugins merged, ADR 0137). */
export const PHYSICS_3D = "myco.physics3d";

/** @internal The World's 3D physics world, or null while it has none. */
export const physics3DOf = (world: World): PhysicsWorld3D | null => world.service<PhysicsWorld3D>(PHYSICS_3D);

/** Component types that start 3D physics: in a loaded scene (one not set to another physics dimension), or attaching later. */
export const PHYSICS_3D_COMPONENTS: readonly string[] = ["engine.RigidBody", "engine.BoxCollider", "engine.SphereCollider", "engine.CapsuleCollider", "engine.MeshCollider", "engine.CharacterController", "engine.FixedJoint", "engine.HingeJoint", "engine.SliderJoint", "engine.BallJoint", "engine.RopeJoint", "engine.SpringJoint"];

/** @internal 3D physics as a World service (ADR 0135, 0137). */
export const PHYSICS_3D_SERVICE = physicsWorldService<PhysicsWorld3D>({
  id: PHYSICS_3D,
  dimension: "3d",
  // A scene saying "3d" starts it, and so does one saying nothing that has 3D bodies or colliders (ADR 0045).
  neededBy: { sceneSetting: { physics: "3d" }, components: PHYSICS_3D_COMPONENTS, exceptSceneSetting: { physics: ["2d", "none"] } },
  create: (world, core, backend) => new core.PhysicsWorld3D(world, backend as PhysicsBackend3D),
  raycast: (p, origin, dir, maxDistance) => p?.raycast(origin, dir, maxDistance) ?? null,
});

// The fixed-step 3D physics systems, after the 2D ones (ADR 0011): in every World, doing nothing in a
// World without a 3D physics world (ADR 0032).
/** @internal */
export const PHYSICS_3D_SYSTEMS: readonly BuiltinSystem[] = [
  // Interpolated bodies (ADR 0093) go back to their simulated pose before fixed-step scripts read them.
  { name: "engine.Physics3DRestoreInterpolated", phase: "fixedUpdate", before: ["engine.FixedUpdateScripts"], run: (w) => physics3DOf(w)?.restoreInterpolated() },
  { name: "engine.Physics3DPush", phase: "fixedUpdate", after: ["engine.FixedUpdateScripts", "engine.PhysicsEvents"], run: (w) => physics3DOf(w)?.push() },
  { name: "engine.Physics3DStep", phase: "fixedUpdate", after: ["engine.Physics3DPush"], run: (w, dt) => physics3DOf(w)?.step(dt) },
  { name: "engine.Physics3DWriteBack", phase: "fixedUpdate", after: ["engine.Physics3DStep"], run: (w) => physics3DOf(w)?.writeBack() },
  { name: "engine.Physics3DEvents", phase: "fixedUpdate", after: ["engine.Physics3DWriteBack"], run: (w) => physics3DOf(w)?.dispatchEvents() },
];
