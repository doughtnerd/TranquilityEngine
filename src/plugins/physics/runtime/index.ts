// The Physics plugin's runtime half (ADR 0005, 0045, 0135, 0137): the 2D and 3D Components, the queries,
// events and fixed-step systems, one World service per dimension, and the backend contribution point.
// Each World service loads the shared sync core (`core/`) with the backend the project chose the first
// time a World needs physics (a scene set to `"physics": "2d"`/`"3d"` or holding bodies or colliders,
// or one attaching later). `myco` exports its public parts (`./public.ts`), and backend plugins
// import this module (ADR 0133: a plugin's one public module).
// Shared physics types and helpers that core reads stay in `src/engine/physics/` (`types.ts`,
// `layers.ts`, `polygon.ts`, `shape3d.ts`).
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import type { RuntimePlugin } from "../../runtimeContext";
import { physicsManifest } from "../manifest";
import { Buoyancy, BUOYANCY_SYSTEM } from "./Buoyancy";
import { PHYSICS_2D_SERVICE, PHYSICS_3D_SERVICE, PHYSICS_DIMENSIONS, PHYSICS_SYSTEMS } from "./dimensions";

export * from "./public";
export { PHYSICS_2D, physics2DOf } from "./systems2d";
export { PHYSICS_3D, physics3DOf } from "./systems3d";
export { physicsDimensionOf } from "./dimensions";
// Backends (ADR 0137)
export { selectPhysicsBackend } from "./backend";
export type * from "./backend";

export const physicsRuntimePlugin: RuntimePlugin = {
  manifest: physicsManifest,
  activate(context) {
    // Each dimension's Components and systems come from its description (ADR 0283); Buoyancy is in neither.
    for (const d of PHYSICS_DIMENSIONS) context.registerComponents(d.components);
    context.registerComponents([Buoyancy]);
    context.registerEngineSystems([...PHYSICS_SYSTEMS, BUOYANCY_SYSTEM]);
    context.registerWorldService(PHYSICS_2D_SERVICE);
    context.registerWorldService(PHYSICS_3D_SERVICE);
  },
};
