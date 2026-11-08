// The Physics 2D plugin's runtime half (ADR 0005, 0135): its Components, its fixed-step systems and the
// World service that loads Rapier 2D when a World first needs it (a scene set to `"physics": "2d"` or
// holding 2D bodies or colliders, or one attaching later). `myco` (`src/myco.ts`) exports the public
// parts from here. Shared physics types and the polygon helpers the tilemap's collision shapes use stay
// in `src/engine/physics/`.
// Runtime code: never imports from `src/editor/` or the plugin's `editor/` folder; Rapier loads on demand.
import type { RuntimePlugin } from "../../runtimeContext";
import { physics2dManifest } from "../manifest";
import { CharacterController2D } from "./CharacterController2D";
import { BoxCollider2D, CircleCollider2D, EdgeCollider2D, PolygonCollider2D } from "./Collider2D";
import { FixedJoint2D, HingeJoint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "./Joint2D";
import { PHYSICS_2D_SERVICE, PHYSICS_2D_SYSTEMS } from "./physics2dSystems";
import { RigidBody2D } from "./RigidBody2D";
import { TilemapCollider2D } from "./TilemapCollider2D";

export { RigidBody2D, type BodyType, type ForceMode } from "./RigidBody2D";
export { BoxCollider2D, CircleCollider2D, Collider2D, EdgeCollider2D, PolygonCollider2D, type ColliderPoint2D, type Collision2D, type PhysicsMaterial, type PhysicsMaterial2D } from "./Collider2D";
export { Physics2D, type RaycastHit2D, type ShapeCastHit2D } from "./Physics2D";
export { CharacterController2D, type ControllerColliderHit2D } from "./CharacterController2D";
export { AxisJoint2D, FixedJoint2D, HingeJoint2D, Joint2D, RopeJoint2D, SliderJoint2D, SpringJoint2D } from "./Joint2D";
export { TilemapCollider2D } from "./TilemapCollider2D";
export { CollisionEvents2D, TriggerEvents2D, PHYSICS_2D, physics2DOf, type PhysicsEvent2D } from "./physics2dSystems";

export const physics2dRuntimePlugin: RuntimePlugin = {
  manifest: physics2dManifest,
  activate(context) {
    context.registerComponents([RigidBody2D, BoxCollider2D, CircleCollider2D, PolygonCollider2D, EdgeCollider2D, TilemapCollider2D, CharacterController2D, FixedJoint2D, HingeJoint2D, SliderJoint2D, RopeJoint2D, SpringJoint2D]);
    context.registerEngineSystems(PHYSICS_2D_SYSTEMS);
    context.registerWorldService(PHYSICS_2D_SERVICE);
  },
};
