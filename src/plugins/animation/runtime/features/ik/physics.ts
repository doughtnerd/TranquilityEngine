// The physics plugin's public query API for the rig (ADR 0370, 0374; T40t): grounder rays are cast with `Physics.raycast`
// (never the backend, ADR 0010). Physics is an optional dependency, so its module is loaded with `import()` when it is
// active for this activation (D113), and dropped when it isn't. Until it has loaded, and without physics, rays miss.
import type { Physics as PhysicsApi } from "../../../../physics/runtime";

let active = false;
let physics: typeof PhysicsApi | null = null;
let loading: Promise<void> | null = null;

/** @internal Whether grounder rays are cast: set at each activation (loads the physics module the first time it's on). */
export function setRigPhysics(on: boolean): void {
  active = on;
  if (on && !physics && !loading) {
    loading = import("../../../../physics/runtime").then(
      (m) => {
        physics = m.Physics;
      },
      (err: unknown) => {
        loading = null;
        console.warn(`[myco] animation: grounder rays can't be cast: the physics module failed to load (${String(err)}).`);
      },
    );
  }
}

/** @internal The physics query API while physics is active and loaded, else null. */
export function rigPhysics(): typeof PhysicsApi | null {
  return active ? physics : null;
}
