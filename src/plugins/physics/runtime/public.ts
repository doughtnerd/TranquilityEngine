// The Physics plugin's public runtime surface: every name `myco` exports for it (`src/myco.ts` re-exports this module
// whole, ADR 0447). Public names only: the plugin's RuntimePlugin object and its internals stay in `index.ts`.
export { RigidBody2D, type BodyType, type ForceMode } from "./RigidBody2D";
export { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, PolygonCollider2D, type ColliderPoint2D, type Collision2D, type PhysicsMaterial, type PhysicsMaterial2D } from "./Collider2D";
export { Physics2D, type RaycastHit2D, type ShapeCastHit2D } from "./Physics2D";
export { CharacterController2D, type ControllerColliderHit2D } from "./CharacterController2D";
export { AxisJoint2D, FixedJoint2D, HingeJoint2D, Joint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "./Joint2D";
export { ShapeCollider2D } from "./ShapeCollider2D";
export { CollisionEvents2D, TriggerEvents2D, type PhysicsEvent2D } from "./systems2d";
export { RigidBody, type RigidBodyConstraints } from "./RigidBody";
export { BoxCollider, CapsuleCollider, Collider, MeshCollider, SphereCollider, type CapsuleDirection, type Collision } from "./Collider";
export { Physics, type RaycastHit, type ShapeCastHit } from "./Physics";
export { CharacterController, type CollisionFlags, type ControllerColliderHit } from "./CharacterController";
export { AxisJoint, BallJoint, FixedJoint, HingeJoint, Joint, RopeJoint, SliderJoint, SpringJoint, type BallDrive, type BallSwing, type JointKind, type JointLimits, type JointMotor, type JointSpring } from "./Joint";
export { CollisionEvents, TriggerEvents, type PhysicsEvent } from "./systems3d";
export { Buoyancy, type BuoyancyMode } from "./Buoyancy";

// The backend contribution point (ADR 0137), so a third-party backend plugin can be written against `myco` alone.
export { PHYSICS_BACKENDS, physicsBackends, registerPhysicsBackend } from "./backend";
export type { Vec2 as PhysicsVec2, Vec3 as PhysicsVec3, Quat as PhysicsQuat, Point2 as PhysicsPoint2, ShapeDesc2D, ShapeDesc3D, QueryShape2D, QueryShape3D, JointKind2D, JointKind3D, JointSettings, DimensionTypes, Dim2, Dim3, Pose, BodySettings, BackendBody, ColliderDesc, BackendCollider, JointDesc, BackendJoint, CharacterSettings, CharacterHit, BackendCharacter, RayHit, PhysicsCapabilities, PhysicsWorldBackend, PhysicsWorldOptions, PhysicsBackend, PhysicsBackend2D, PhysicsBackend3D, PhysicsWorld2DBackend, PhysicsWorld3DBackend, PhysicsDimension, PhysicsBackendRegistration, VoxelChange2D, VoxelLink2D } from "./backend";

// ADR 0439 renamed TilemapCollider2D; scripts naming the old class keep working.
import { ShapeCollider2D as _ShapeCollider2D } from "./ShapeCollider2D";
/** @deprecated Renamed `ShapeCollider2D` (ADR 0439): the same class, so `getComponent(TilemapCollider2D)` still finds it. */
export const TilemapCollider2D = _ShapeCollider2D;
/** @deprecated Renamed `ShapeCollider2D` (ADR 0439). */
export type TilemapCollider2D = _ShapeCollider2D;
