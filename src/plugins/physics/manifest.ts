// The Physics plugin's manifest (ADR 0005, 0045, 0133, 0135, 0137): backend-neutral 2D and 3D physics —
// bodies, colliders (tilemap colliders included), joints, character controllers, buoyancy, queries and
// events — over a backend another plugin contributes (Rapier: `myco.physics-rapier`). It replaced the
// `myco.physics2d` and `myco.physics3d` plugins (old names in `plugins.disabled` map here, `enabled.ts`).
// Its editor half (`editor/`) holds the Project panel's physics category and the "no physics backend" note; the collider and joint gizmos
// still live in `src/editor/` until the viewport-tool contribution point lands.
import type { PluginManifest } from "../manifest";

export const physicsManifest: PluginManifest = {
  name: "myco.physics",
  title: "Physics",
  description: "2D and 3D bodies, colliders, joints, character controllers and buoyancy, over a physics backend.",
  // First-party plugins carry the engine's version: keep in step with package.json's "version".
  version: "1.0.0",
};
