/**
 * 2D physics entry points that don't need Rapier loaded, like `physics3d.ts` (ADR 0045): the event
 * buffers, the fixed-step systems, and `ensurePhysics2D`, which loads Rapier 2D (and
 * `Physics2DWorld`) the first time a World needs it, so the editor and games start without
 * downloading and compiling it.
 */
import { defineBuffer } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
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

let loading: Promise<typeof import("./Physics2DWorld")> | null = null;

/** @internal Create the world's 2D physics world, loading Rapier 2D's WASM once. */
export async function ensurePhysics2D(world: World): Promise<Physics2DWorld> {
  loading ??= import("./Physics2DWorld")
    .then(async (m) => (await m.initRapier2D(), m))
    .catch((err: unknown) => {
      loading = null; // a failed fetch or WASM start is tried again next time
      throw err;
    });
  const mod = await loading;
  if (!world.physics2D) world.physics2D = new mod.Physics2DWorld(world);
  return world.physics2D;
}

// The fixed-step physics systems, in the order of ADR 0011: catalog entries for every World, doing
// nothing in a World without a 2D physics world (ADR 0032).
// Interpolated bodies (ADR 0093) go back to their simulated pose before fixed-step scripts read them.
defineBuiltinSystem({
  name: "engine.PhysicsRestoreInterpolated",
  phase: "fixedUpdate",
  before: ["engine.FixedUpdateScripts"],
  run: (w) => (w.physics2D?.restoreInterpolated(), w.physics3D?.restoreInterpolated()),
});
defineBuiltinSystem({ name: "engine.PhysicsPush", phase: "fixedUpdate", after: ["engine.FixedUpdateScripts"], run: (w) => w.physics2D?.push() });
defineBuiltinSystem({ name: "engine.PhysicsStep", phase: "fixedUpdate", after: ["engine.PhysicsPush"], run: (w, dt) => w.physics2D?.step(dt) });
defineBuiltinSystem({ name: "engine.PhysicsWriteBack", phase: "fixedUpdate", after: ["engine.PhysicsStep"], run: (w) => w.physics2D?.writeBack() });
defineBuiltinSystem({ name: "engine.PhysicsEvents", phase: "fixedUpdate", after: ["engine.PhysicsWriteBack"], run: (w) => w.physics2D?.dispatchEvents() });
