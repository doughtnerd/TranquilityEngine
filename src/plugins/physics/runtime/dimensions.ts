/**
 * The two physics dimensions, each described once (ADR 0283): its World service id, the Components that work
 * in it and need its backend, its fixed-step systems' names, and how its physics world is made. The World
 * services, the systems, the Components the plugin registers and the editor's "(no physics backend)" lookup
 * are all derived from these. Buoyancy is in neither: its kinematic mode needs no backend, and its physics mode
 * pushes a RigidBody, which is the 3D description's.
 */
import type { PhysicsBackend2D, PhysicsBackend3D, PhysicsDimension } from "./backend";
import { CharacterController } from "./CharacterController";
import { CharacterController2D } from "./CharacterController2D";
import { BoxCollider, CapsuleCollider, MeshCollider, SphereCollider } from "./Collider";
import { BoxCollider2D, CircleCollider2D, EdgeCollider2D, PolygonCollider2D } from "./Collider2D";
import type { PhysicsWorld2D } from "./core/PhysicsWorld2D";
import type { PhysicsWorld3D } from "./core/PhysicsWorld3D";
import { BallJoint, FixedJoint, HingeJoint, RopeJoint, SliderJoint, SpringJoint } from "./Joint";
import { FixedJoint2D, HingeJoint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "./Joint2D";
import { RigidBody } from "./RigidBody";
import { RigidBody2D } from "./RigidBody2D";
import { componentIds, physicsSystems, physicsWorldService, type PhysicsDimensionDescription, type PhysicsDimensionInfo } from "./services";
import { PHYSICS_2D } from "./systems2d";
import { PHYSICS_3D } from "./systems3d";
import { ShapeCollider2D } from "./ShapeCollider2D";

const PHYSICS_2D_DIMENSION: PhysicsDimensionDescription<PhysicsWorld2D> = {
  dimension: "2d",
  serviceId: PHYSICS_2D,
  components: [RigidBody2D, BoxCollider2D, CircleCollider2D, PolygonCollider2D, EdgeCollider2D, ShapeCollider2D, CharacterController2D, FixedJoint2D, HingeJoint2D, SliderJoint2D, RopeJoint2D, SpringJoint2D],
  systemStem: "engine.Physics",
  create: (world, core, backend) => new core.PhysicsWorld2D(world, backend as PhysicsBackend2D),
};

const PHYSICS_3D_DIMENSION: PhysicsDimensionDescription<PhysicsWorld3D> = {
  dimension: "3d",
  serviceId: PHYSICS_3D,
  components: [RigidBody, BoxCollider, SphereCollider, CapsuleCollider, MeshCollider, CharacterController, FixedJoint, HingeJoint, SliderJoint, BallJoint, RopeJoint, SpringJoint],
  systemStem: "engine.Physics3D",
  create: (world, core, backend) => new core.PhysicsWorld3D(world, backend as PhysicsBackend3D),
  raycast: (p, origin, dir, maxDistance) => p?.raycast(origin, dir, maxDistance) ?? null,
  // No backend loaded (p is null): no answer, like no service (ADR 0162, C14).
  raycastInto: (p, out, origin, dir, maxDistance, query) => (p === null ? false : p.raycastInto(out, origin, dir, maxDistance, query)),
};

/** @internal The dimensions, in the order their fixed steps run (ADR 0011). */
export const PHYSICS_DIMENSIONS: readonly PhysicsDimensionInfo[] = [PHYSICS_2D_DIMENSION, PHYSICS_3D_DIMENSION];

/** @internal Each dimension's World service (ADR 0135, 0137). */
export const PHYSICS_2D_SERVICE = physicsWorldService(PHYSICS_2D_DIMENSION);
export const PHYSICS_3D_SERVICE = physicsWorldService(PHYSICS_3D_DIMENSION);

/** @internal Every dimension's fixed-step systems. */
export const PHYSICS_SYSTEMS = physicsSystems(PHYSICS_DIMENSIONS);

const dimensionById = new Map<string, PhysicsDimension>(PHYSICS_DIMENSIONS.flatMap((d) => componentIds(d).map((id) => [id, d.dimension] as const)));

/** @internal The dimension a Component type works in and whose backend it needs, or null (not a physics Component, or Buoyancy). */
export const physicsDimensionOf = (type: string): PhysicsDimension | null => dimensionById.get(type) ?? null;
