// The Physics plugin's runtime half (ADR 0005, 0045, 0135, 0137): the 2D and 3D Components, the queries,
// events and fixed-step systems, one World service per dimension, and the backend contribution point.
// Each World service loads the shared sync core (`core/`) with the backend the project chose the first
// time a World needs physics (a scene set to `"physics": "2d"`/`"3d"` or holding bodies or colliders,
// or one attaching later). `myco` (`src/myco.ts`) exports the public parts from here, and backend plugins
// import this module (ADR 0133: a plugin's one public module).
// Shared physics types and helpers that core reads stay in `src/engine/physics/` (`types.ts`,
// `layers.ts`, `polygon.ts`, `shape3d.ts`).
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder.
import type { RuntimePlugin } from "../../runtimeContext";
import { physicsManifest } from "../manifest";
import { Buoyancy, BUOYANCY_SYSTEM } from "./Buoyancy";
import { CharacterController } from "./CharacterController";
import { CharacterController2D } from "./CharacterController2D";
import { BoxCollider, CapsuleCollider, MeshCollider, SphereCollider } from "./Collider";
import { BoxCollider2D, CircleCollider2D, EdgeCollider2D, PolygonCollider2D } from "./Collider2D";
import { BallJoint, FixedJoint, HingeJoint, RopeJoint, SliderJoint, SpringJoint } from "./Joint";
import { FixedJoint2D, HingeJoint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "./Joint2D";
import { RigidBody } from "./RigidBody";
import { RigidBody2D } from "./RigidBody2D";
import { PHYSICS_2D_SERVICE, PHYSICS_2D_SYSTEMS } from "./systems2d";
import { PHYSICS_3D_SERVICE, PHYSICS_3D_SYSTEMS } from "./systems3d";
import { TilemapCollider2D } from "./TilemapCollider2D";

// 2D
export { RigidBody2D, type BodyType, type ForceMode } from "./RigidBody2D";
export { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, PolygonCollider2D, type ColliderPoint2D, type Collision2D, type PhysicsMaterial, type PhysicsMaterial2D } from "./Collider2D";
export { Physics2D, type RaycastHit2D, type ShapeCastHit2D } from "./Physics2D";
export { CharacterController2D, type ControllerColliderHit2D } from "./CharacterController2D";
export { AxisJoint2D, FixedJoint2D, HingeJoint2D, Joint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "./Joint2D";
export { TilemapCollider2D } from "./TilemapCollider2D";
export { CollisionEvents2D, TriggerEvents2D, PHYSICS_2D, physics2DOf, type PhysicsEvent2D } from "./systems2d";
// 3D
export { RigidBody, type RigidBodyConstraints } from "./RigidBody";
export { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider, type CapsuleDirection, type Collision } from "./Collider";
export { Physics, type RaycastHit, type ShapeCastHit } from "./Physics";
export { CharacterController, type CollisionFlags, type ControllerColliderHit } from "./CharacterController";
export { AxisJoint, BallJoint, FixedJoint, HingeJoint, Joint, RopeJoint, SliderJoint, SpringJoint, type JointLimits, type JointMotor, type JointSpring } from "./Joint";
export { CollisionEvents, TriggerEvents, PHYSICS_3D, physics3DOf, type PhysicsEvent } from "./systems3d";
export { Buoyancy, type BuoyancyMode } from "./Buoyancy";
// Backends (ADR 0137)
export { PHYSICS_BACKENDS, physicsBackends, registerPhysicsBackend, selectPhysicsBackend } from "./backend";
export type * from "./backend";

export const physicsRuntimePlugin: RuntimePlugin = {
  manifest: physicsManifest,
  activate(context) {
    context.registerComponents([RigidBody2D, BoxCollider2D, CircleCollider2D, PolygonCollider2D, EdgeCollider2D, TilemapCollider2D, CharacterController2D, FixedJoint2D, HingeJoint2D, SliderJoint2D, RopeJoint2D, SpringJoint2D]);
    context.registerComponents([RigidBody, BoxCollider, SphereCollider, CapsuleCollider, MeshCollider, CharacterController, FixedJoint, HingeJoint, SliderJoint, BallJoint, RopeJoint, SpringJoint, Buoyancy]);
    context.registerEngineSystems([...PHYSICS_2D_SYSTEMS, ...PHYSICS_3D_SYSTEMS, BUOYANCY_SYSTEM]);
    context.registerWorldService(PHYSICS_2D_SERVICE);
    context.registerWorldService(PHYSICS_3D_SERVICE);
  },
};
