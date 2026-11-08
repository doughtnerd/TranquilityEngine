// The Physics 3D plugin's manifest (ADR 0045, 0133, 0135): Rapier 3D bodies, colliders, joints, the
// character controller and buoyancy. Runtime only for now: its editor parts (collider and joint gizmos,
// the Project panel's physics section) still live in `src/editor/`.
import type { PluginManifest } from "../manifest";

export const physics3dManifest: PluginManifest = {
  name: "myco.physics3d",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
