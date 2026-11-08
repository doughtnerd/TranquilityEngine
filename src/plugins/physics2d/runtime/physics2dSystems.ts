/**
 * 2D physics entry points that don't need Rapier loaded (ADR 0005, 0135), like Physics 3D's
 * `physics3d.ts`: the event buffers, the World service (which loads Rapier 2D and `Physics2DWorld`
 * the first time a World needs them, so the editor and games start without downloading and compiling
 * it) and the fixed-step systems.
 */
import { defineBuffer } from "../../../engine/core/data";
import type { BuiltinSystem } from "../../../engine/core/systems";
import type { World } from "../../../engine/core/World";
import type { WorldServiceDef } from "../../../engine/core/worldServices";
import type { Collider2D } from "./Collider2D";
import type { Physics2DWorld } from "./Physics2DWorld";

/** Physics events for systems (ADR 0017). Filled during fixed steps, cleared at end of frame. */
export interface PhysicsEvent2D {
  readonly a: Collider2D;
  readonly b: Collider2D;
  readonly started: boolean;
}
export const TriggerEvents2D = defineBuffer<PhysicsEvent2D>("engine.TriggerEvents2D");
export const CollisionEvents2D = defineBuffer<PhysicsEvent2D>("engine.CollisionEvents2D");

/** The World service's id (ADR 0135). */
export const PHYSICS_2D = "myco.physics2d";

/** @internal The World's 2D physics world, or null while it has none. */
export const physics2DOf = (world: World): Physics2DWorld | null => world.service<Physics2DWorld>(PHYSICS_2D);

/** Component types that start 2D physics: in a loaded scene (one not set to another physics dimension), or attaching later. */
export const PHYSICS_2D_COMPONENTS: readonly string[] = ["engine.RigidBody2D", "engine.BoxCollider2D", "engine.CircleCollider2D", "engine.PolygonCollider2D", "engine.EdgeCollider2D", "engine.TilemapCollider2D", "engine.CharacterController2D", "engine.FixedJoint2D", "engine.HingeJoint2D", "engine.SliderJoint2D", "engine.RopeJoint2D", "engine.SpringJoint2D"];

type Physics2DModule = typeof import("./Physics2DWorld");

/** @internal 2D physics as a World service (ADR 0135). */
export const PHYSICS_2D_SERVICE: WorldServiceDef<Physics2DModule, Physics2DWorld> = {
  id: PHYSICS_2D,
  // A scene saying "2d" (ADR 0014) starts it, and so does one saying nothing that has 2D bodies or colliders.
  neededBy: { sceneSetting: { physics: "2d" }, components: PHYSICS_2D_COMPONENTS, exceptSceneSetting: { physics: ["3d", "none"] } },
  load: () => import("./Physics2DWorld").then(async (m) => (await m.initRapier2D(), m)),
  create: (world, m) => new m.Physics2DWorld(world),
  dispose: (p) => p.rapier.free(),
  interpolate: (p, alpha) => p.interpolate(alpha),
};

// The fixed-step physics systems, in the order of ADR 0011: in every World, doing nothing in a World
// without a 2D physics world (ADR 0032).
/** @internal */
export const PHYSICS_2D_SYSTEMS: readonly BuiltinSystem[] = [
  // Interpolated bodies (ADR 0093) go back to their simulated pose before fixed-step scripts read them.
  { name: "engine.PhysicsRestoreInterpolated", phase: "fixedUpdate", before: ["engine.FixedUpdateScripts"], run: (w) => physics2DOf(w)?.restoreInterpolated() },
  { name: "engine.PhysicsPush", phase: "fixedUpdate", after: ["engine.FixedUpdateScripts"], run: (w) => physics2DOf(w)?.push() },
  { name: "engine.PhysicsStep", phase: "fixedUpdate", after: ["engine.PhysicsPush"], run: (w, dt) => physics2DOf(w)?.step(dt) },
  { name: "engine.PhysicsWriteBack", phase: "fixedUpdate", after: ["engine.PhysicsStep"], run: (w) => physics2DOf(w)?.writeBack() },
  { name: "engine.PhysicsEvents", phase: "fixedUpdate", after: ["engine.PhysicsWriteBack"], run: (w) => physics2DOf(w)?.dispatchEvents() },
];
