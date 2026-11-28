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
  // Where the Add Component menu lists its Components.
  componentCategories: {
    "Physics 2D": ["engine.RigidBody2D", "engine.BoxCollider2D", "engine.CircleCollider2D", "engine.PolygonCollider2D", "engine.EdgeCollider2D", "engine.ShapeCollider2D", "engine.CharacterController2D", "engine.FixedJoint2D", "engine.HingeJoint2D", "engine.SliderJoint2D", "engine.RopeJoint2D", "engine.SpringJoint2D"],
    "Physics 3D": ["engine.RigidBody", "engine.BoxCollider", "engine.SphereCollider", "engine.CapsuleCollider", "engine.MeshCollider", "engine.CharacterController", "engine.FixedJoint", "engine.HingeJoint", "engine.SliderJoint", "engine.BallJoint", "engine.RopeJoint", "engine.SpringJoint", "engine.Buoyancy"],
  },
};
