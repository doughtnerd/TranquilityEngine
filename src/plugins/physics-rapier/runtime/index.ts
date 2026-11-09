// The Rapier physics plugin's runtime half (ADR 0137): registers Rapier 2D and Rapier 3D as backends of
// the Physics plugin (it imports that plugin's public module, ADR 0133). Each backend loads with its
// WebAssembly only when a World first needs physics in its dimension.
// Runtime code: never imports from `src/editor/` or an `editor/` folder.
import { PHYSICS_BACKENDS } from "../../physics/runtime";
import type { RuntimePlugin } from "../../runtimeContext";
import { physicsRapierManifest } from "../manifest";

/** The backends' id, for `physics.backend2d` / `physics.backend3d`. */
export const RAPIER_BACKEND = "rapier";

export const physicsRapierRuntimePlugin: RuntimePlugin = {
  manifest: physicsRapierManifest,
  activate(context) {
    context.contribute(PHYSICS_BACKENDS, { id: RAPIER_BACKEND, dimension: "2d", title: "Rapier 2D", load: () => import("./rapier2d").then(async (m) => (await m.initRapier2D(), m.rapier2DBackend)), prefetch: () => import("./rapier2d") });
    context.contribute(PHYSICS_BACKENDS, { id: RAPIER_BACKEND, dimension: "3d", title: "Rapier 3D", load: () => import("./rapier3d").then(async (m) => (await m.initRapier3D(), m.rapier3DBackend)), prefetch: () => import("./rapier3d") });
  },
};
