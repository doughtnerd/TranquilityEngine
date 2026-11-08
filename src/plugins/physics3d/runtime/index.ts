// The Physics 3D plugin's runtime half (ADR 0045, 0135): its Components, its fixed-step systems and the
// World service that loads Rapier 3D when a World first needs it (a scene with 3D bodies or colliders,
// or one attaching later). `myco` (`src/myco.ts`) exports the public parts from here.
// Shared physics types and helpers that core or the other physics plugin read stay in
// `src/engine/physics/` (`types.ts`, `layers.ts`, `shape3d.ts`).
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; Rapier loads on demand.
import type { RuntimePlugin } from "../../runtimeContext";
import { physics3dManifest } from "../manifest";
import { Buoyancy, BUOYANCY_SYSTEM } from "./Buoyancy";
import { CharacterController } from "./CharacterController";
import { BoxCollider, CapsuleCollider, MeshCollider, SphereCollider } from "./Collider";
import { BallJoint, FixedJoint, HingeJoint, RopeJoint, SliderJoint, SpringJoint } from "./Joint";
import { PHYSICS_3D_SERVICE, PHYSICS_3D_SYSTEMS } from "./physics3d";
import { RigidBody } from "./RigidBody";

export { RigidBody, type RigidBodyConstraints } from "./RigidBody";
export { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider, type CapsuleDirection, type Collision } from "./Collider";
export { Physics, type RaycastHit, type ShapeCastHit } from "./Physics";
export { CharacterController, type CollisionFlags, type ControllerColliderHit } from "./CharacterController";
export { AxisJoint, BallJoint, FixedJoint, HingeJoint, Joint, RopeJoint, SliderJoint, SpringJoint, type JointLimits, type JointMotor, type JointSpring } from "./Joint";
export { CollisionEvents, TriggerEvents, PHYSICS_3D, physics3DOf, type PhysicsEvent } from "./physics3d";
export { Buoyancy, type BuoyancyMode } from "./Buoyancy";

export const physics3dRuntimePlugin: RuntimePlugin = {
  manifest: physics3dManifest,
  activate(context) {
    context.registerComponents([RigidBody, BoxCollider, SphereCollider, CapsuleCollider, MeshCollider, CharacterController, FixedJoint, HingeJoint, SliderJoint, BallJoint, RopeJoint, SpringJoint, Buoyancy]);
    context.registerEngineSystems([...PHYSICS_3D_SYSTEMS, BUOYANCY_SYSTEM]);
    context.registerWorldService(PHYSICS_3D_SERVICE);
  },
};
