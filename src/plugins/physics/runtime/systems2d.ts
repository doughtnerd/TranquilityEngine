/**
 * 2D physics entry points that don't need a backend loaded (ADR 0005, 0135, 0137), like `systems3d.ts`:
 * the event buffers, the World service's id and the World's 2D physics world. The service and the
 * fixed-step systems are derived from the 2D description in `dimensions.ts` (ADR 0283).
 */
import { defineBuffer } from "../../../engine/core/data";
import type { World } from "../../../engine/core/World";
import type { Collider2D } from "./Collider2D";
import type { PhysicsWorld2D } from "./core/PhysicsWorld2D";

/** Physics events for systems (ADR 0017). Filled during fixed steps, cleared at end of frame. */
export interface PhysicsEvent2D {
  readonly a: Collider2D;
  readonly b: Collider2D;
  readonly started: boolean;
}
export const TriggerEvents2D = defineBuffer<PhysicsEvent2D>("engine.TriggerEvents2D");
export const CollisionEvents2D = defineBuffer<PhysicsEvent2D>("engine.CollisionEvents2D");

/** The World service's id (ADR 0135; it kept its name when the 2D and 3D plugins merged, ADR 0137). */
export const PHYSICS_2D = "myco.physics2d";

/** @internal The World's 2D physics world, or null while it has none. */
export const physics2DOf = (world: World): PhysicsWorld2D | null => world.service<PhysicsWorld2D>(PHYSICS_2D);
