/**
 * 3D physics entry points that don't need a backend loaded (ADR 0045, 0135, 0137), like `systems2d.ts`:
 * the event buffers, the World service's id and the World's 3D physics world. The service and the
 * fixed-step systems are derived from the 3D description in `dimensions.ts` (ADR 0283).
 */
import { defineBuffer } from "../../../engine/core/data";
import type { World } from "../../../engine/core/World";
import type { Collider } from "./Collider";
import type { PhysicsWorld3D } from "./core/PhysicsWorld3D";

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
