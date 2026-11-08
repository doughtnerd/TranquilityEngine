// The Physics 2D plugin's manifest (ADR 0005, 0133, 0135): Rapier 2D bodies, colliders (tilemap
// colliders included), joints and the character controller. Runtime only for now: its editor parts
// (collider and joint gizmos, the Project panel's physics section) still live in `src/editor/`.
import type { PluginManifest } from "../manifest";

export const physics2dManifest: PluginManifest = {
  name: "myco.physics2d",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
