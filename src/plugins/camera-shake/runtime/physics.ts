// Collision and trigger impulses (ADR 0436) read the Physics plugin's contact buffers and bodies. Physics is an optional
// dependency, so its module is loaded with `import()` when it is active for this activation (as the Animation plugin's
// grounder does, ADR 0374), and dropped when it isn't. Until it has loaded, and without physics, those triggers send
// nothing.
import type * as PhysicsModule from "../../physics/runtime";

export type ShakePhysics = Pick<typeof PhysicsModule, "CollisionEvents" | "CollisionEvents2D" | "TriggerEvents" | "TriggerEvents2D" | "RigidBody" | "RigidBody2D">;

let active = false;
let physics: ShakePhysics | null = null;
let loading: Promise<void> | null = null;

/** Whether collision and trigger impulses are on: set at each activation (loads the physics module the first time it's on). */
export function setShakePhysics(on: boolean): void {
  active = on;
  if (on && !physics && !loading) {
    loading = import("../../physics/runtime").then(
      (m) => {
        physics = m;
      },
      (err: unknown) => {
        loading = null;
        console.warn(`[myco] camera shake: collision and trigger impulses are off: the physics module failed to load (${String(err)}).`);
      },
    );
  }
}

/** The physics module while physics is active and loaded, else null. */
export function shakePhysics(): ShakePhysics | null {
  return active ? physics : null;
}
